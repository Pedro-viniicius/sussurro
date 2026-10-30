import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { DbHandle } from '@sussurro/db';
import { sanitizeError } from '@sussurro/shared';
import type { Redis } from 'ioredis';

import { WorkerConfig } from './config/config.module.js';
import { Clock } from './infra/clock.js';
import { closeRedisClient, DATABASE, REDIS } from './infra/connections.js';
import { describeError } from './infra/describe-error.js';
import { ObjectStorage } from './infra/storage.js';
import { runMaintenance } from './jobs/maintenance.js';
import { MediaJobsConsumer } from './media/media-jobs.consumer.js';
import { VideoEventsConsumer } from './media/video-events.consumer.js';
import { checkPushReceipts } from './push/push-receipts.js';
import { PushSender } from './push/push-sender.js';
import { PushConsumer } from './push/push.consumer.js';

/** Primeira execução do job de manutenção logo depois de subir (sem atrasar o boot). */
export const FIRST_MAINTENANCE_DELAY_MS = 5_000;

/**
 * Ciclo de vida do worker:
 * - consumidor da fila `media-jobs` (Fase 2): processa fotos de post e de perfil e (Fase 5) entrega
 *   o vídeo dos reels ao `VideoProcessor`;
 * - consumidor da fila `video-events` (Fase 5, só com o MediaConvert): fim dos jobs de vídeo;
 * - consumidor da fila `push` (Fase 6, ADR 0011): envio ao Expo em lotes;
 * - job de manutenção a cada `MAINTENANCE_INTERVAL_MS` (`setInterval`, uma execução por vez):
 *   hard delete de contas (com objetos do S3 e recálculo de contadores), tokens vencidos, a
 *   limpeza da 2.11 (rascunhos, posts apagados, uploads de avatar) e (Fase 6) a retenção das
 *   notificações e dos push tokens. Duas réplicas podem rodar o job ao mesmo tempo: as linhas são
 *   reservadas com `FOR UPDATE SKIP LOCKED` (2.11 CA2);
 * - (Fase 6) consulta dos recibos do Expo a cada `PUSH_RECEIPTS_INTERVAL_MS`.
 */
@Injectable()
export class WorkerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerLifecycle.name);
  private interval: NodeJS.Timeout | undefined;
  private receiptsInterval: NodeJS.Timeout | undefined;
  private firstRun: NodeJS.Timeout | undefined;
  private active = false;
  private inFlight: Promise<void> | undefined;
  private receiptsInFlight: Promise<void> | undefined;

  constructor(
    private readonly config: WorkerConfig,
    @Inject(DATABASE) private readonly database: Pick<DbHandle, 'db' | 'close'>,
    @Inject(REDIS) private readonly redis: Pick<Redis, 'status' | 'quit' | 'disconnect'>,
    private readonly storage: ObjectStorage,
    private readonly consumer: MediaJobsConsumer,
    private readonly clock: Clock,
    /** Fase 5: só com `VIDEO_PROCESSOR=mediaconvert` (o passthrough não tem eventos). */
    @Inject(VideoEventsConsumer) private readonly videoEvents: VideoEventsConsumer | null,
    /** Fase 6: fila `push` e quem fala com o Expo (os recibos). */
    private readonly push: PushConsumer,
    private readonly pushSender: PushSender,
  ) {}

  get running(): boolean {
    return this.active;
  }

  /** O consumidor da `video-events` está rodando (só com o MediaConvert). */
  get consumingVideoEvents(): boolean {
    return this.videoEvents?.active ?? false;
  }

  /** O consumidor da `push` está rodando (Fase 6). */
  get consumingPush(): boolean {
    return this.push.active;
  }

  onApplicationBootstrap(): void {
    this.active = true;
    this.consumer.start();
    this.videoEvents?.start();
    this.push.start();
    this.firstRun = setTimeout(() => {
      this.scheduleMaintenance();
    }, FIRST_MAINTENANCE_DELAY_MS);
    this.interval = setInterval(() => {
      this.scheduleMaintenance();
    }, this.config.env.MAINTENANCE_INTERVAL_MS);
    this.receiptsInterval = setInterval(() => {
      if (this.active) {
        void this.checkReceiptsNow();
      }
    }, this.config.env.PUSH_RECEIPTS_INTERVAL_MS);
    this.logger.log(
      `Worker iniciado (${this.config.env.NODE_ENV}, vídeo: ${this.config.env.VIDEO_PROCESSOR}, ` +
        `push: ${this.config.env.PUSH_SENDER})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.active = false;
    clearTimeout(this.firstRun);
    clearInterval(this.interval);
    clearInterval(this.receiptsInterval);
    this.firstRun = undefined;
    this.interval = undefined;
    this.receiptsInterval = undefined;
    // Não fecha o banco no meio de uma mensagem nem de um lote.
    await Promise.all([this.consumer.stop(), this.videoEvents?.stop(), this.push.stop()]);
    await Promise.all([this.inFlight, this.receiptsInFlight]);
    await Promise.all([this.database.close(), closeRedisClient(this.redis)]);
    this.logger.log('Worker desligado: conexões fechadas');
  }

  /**
   * Executa o job agora (uma execução por vez). Erros vão para o log; o próximo ciclo tenta de
   * novo.
   */
  runMaintenanceNow(now: Date = this.clock.now()): Promise<void> {
    const { env } = this.config;
    this.inFlight ??= runMaintenance(this.database.db, this.storage, {
      now,
      purgeAfterDays: env.ACCOUNT_PURGE_AFTER_DAYS,
      draftTtlHours: env.DRAFT_TTL_HOURS,
      processingTimeoutMin: env.MEDIA_PROCESSING_TIMEOUT_MIN,
    })
      .then((result) => {
        const work =
          result.purgedAccounts +
          result.deletedRefreshTokens +
          result.deletedEmailTokens +
          result.drafts +
          result.deletedPosts +
          result.avatarUploads +
          result.stuckMedia +
          result.expiredConnectionRequests +
          result.deletedConnectionRequests +
          result.deletedNotifications +
          result.deletedPushTokens;
        if (work > 0) {
          this.logger.log(
            `Manutenção: ${String(result.purgedAccounts)} contas apagadas ` +
              `(${String(result.recalculatedPosts)} posts recontados), ` +
              `${String(result.deletedRefreshTokens)} sessões e ` +
              `${String(result.deletedEmailTokens)} links de e-mail vencidos, ` +
              `${String(result.drafts)} rascunhos, ${String(result.deletedPosts)} posts apagados, ` +
              `${String(result.avatarUploads)} uploads de avatar, ` +
              `${String(result.stuckMedia)} mídias travadas, ` +
              `${String(result.expiredConnectionRequests)} pedidos de conexão vencidos e ` +
              `${String(result.deletedConnectionRequests)} antigos, ` +
              `${String(result.deletedNotifications)} notificações com mais de 90 dias, ` +
              `${String(result.deletedPushTokens)} push tokens sem uso; ` +
              `${String(result.objects + result.purgedObjects)} objetos removidos do S3`,
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.error(`Falha na manutenção: ${describeError(error)}`);
        // PERM-17: ao Sentry vai a versão limpa (sem os `params` de uma consulta que falhou).
        Sentry.captureException(sanitizeError(error), { tags: { job: 'maintenance' } });
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  /** Consulta os recibos do Expo agora (uma execução por vez). Falha vai para o log e o Sentry. */
  checkReceiptsNow(now: Date = this.clock.now()): Promise<void> {
    this.receiptsInFlight ??= checkPushReceipts(this.database.db, this.pushSender, now)
      .then((result) => {
        if (result.checked + result.expired > 0) {
          this.logger.log(
            `Recibos do push: ${String(result.checked)} consultados, ` +
              `${String(result.disabledTokens)} tokens desativados (DeviceNotRegistered), ` +
              `${String(result.pending)} ainda sem recibo, ${String(result.expired)} descartados`,
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.warn(`Falha ao consultar os recibos do push: ${describeError(error)}`);
        Sentry.captureException(sanitizeError(error), { tags: { job: 'push-receipts' } });
      })
      .finally(() => {
        this.receiptsInFlight = undefined;
      });
    return this.receiptsInFlight;
  }

  private scheduleMaintenance(): void {
    if (this.active) {
      void this.runMaintenanceNow();
    }
  }
}
