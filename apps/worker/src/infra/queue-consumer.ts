import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

import { describeError } from './describe-error.js';
import type { MessageQueue, QueueMessage } from './queue.js';

export interface ConsumerOptions {
  /** Mensagens processadas ao mesmo tempo (e pedidas por chamada ao SQS). */
  concurrency: number;
  /** Long polling (s). */
  waitTimeSeconds: number;
  /** Igual ao `maxReceiveCount` da DLQ. */
  maxAttempts: number;
  /** Espera depois de um erro da fila antes de tentar de novo (ms). */
  errorBackoffMs?: number;
  /** Espera depois de uma rodada vazia (ms); com long polling, a própria espera já passou. */
  idleDelayMs?: number;
}

/**
 * Consumidor de uma fila SQS (ADR 0009): recebe até `concurrency` mensagens, processa em paralelo e
 * apaga as que `process` deu por concluídas. As outras voltam depois do visibility timeout; depois
 * de `maxAttempts` entregas a fila as move para a DLQ (MID-10). Usado pela `media-jobs` (Fase 2) e
 * pela `video-events` (Fase 5).
 */
export abstract class QueueConsumer {
  protected readonly logger: Logger;
  private running = false;
  private loopDone: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly queue: MessageQueue,
    protected readonly options: ConsumerOptions,
    protected readonly queueLabel: string,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  /** `true` = concluída (apagar); `false` = deixar voltar (nova tentativa ou DLQ). */
  protected abstract process(message: QueueMessage): Promise<boolean>;

  get active(): boolean {
    return this.running;
  }

  /** Uma rodada: recebe, processa e apaga. Devolve quantas mensagens chegaram. */
  async pollOnce(waitTimeSeconds = this.options.waitTimeSeconds): Promise<number> {
    const messages = await this.queue.receive(
      this.options.concurrency,
      waitTimeSeconds,
      this.abort?.signal,
    );
    if (messages.length > 0) {
      await this.handleReceived(messages);
    }
    return messages.length;
  }

  /**
   * Processa as mensagens de uma rodada. Padrão: uma a uma, em paralelo. (Fase 6) A `push` sobrescreve
   * para mandar a rodada inteira ao Expo num lote.
   */
  protected async handleReceived(messages: QueueMessage[]): Promise<void> {
    await Promise.all(messages.map((message) => this.processAndAck(message)));
  }

  /** Apaga a mensagem concluída. */
  protected async ack(message: QueueMessage): Promise<void> {
    await this.queue.delete(message.receiptHandle);
  }

  /** Erro fora do previsto (ex.: banco fora): vai para o log e o Sentry (no-op sem DSN). */
  protected reportFailure(message: QueueMessage, error: unknown): void {
    this.logger.error(`Falha ao processar a mensagem ${message.id}: ${describeError(error)}`);
    Sentry.captureException(error, { tags: { queue: this.queueLabel } });
  }

  private async processAndAck(message: QueueMessage): Promise<void> {
    try {
      if (await this.process(message)) {
        await this.ack(message);
      }
    } catch (error) {
      // A mensagem volta depois do visibility timeout.
      this.reportFailure(message, error);
    }
  }

  /** Começa a consumir em segundo plano, até `stop()`. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.loopDone = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const received = await this.pollOnce();
        if (received === 0) {
          // Sem isto, uma fila que responde na hora (long polling 0) prenderia o event loop.
          await this.pause(this.options.idleDelayMs ?? 1_000);
        }
      } catch (error) {
        if (this.abort?.signal.aborted === true) {
          return;
        }
        this.logger.warn(`Fila ${this.queueLabel} indisponível: ${describeError(error)}`);
        await this.pause(this.options.errorBackoffMs ?? 5_000);
      }
    }
  }

  /** Espera interrompível pelo `stop()`. */
  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** Para de receber e espera as mensagens em processamento terminarem. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.wake?.();
    await this.loopDone;
    this.loopDone = undefined;
  }
}

export function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
