import { Logger } from '@nestjs/common';
import { type Database, eq, pushTickets, pushTokens } from '@sussurro/db';
import type { PushJobMessage } from '@sussurro/shared';

import { activePushTokens, loadPushContent, type PushContent } from './push-content.js';
import type { OutgoingPush, PushSender, PushTicket } from './push-sender.js';
import type { Clock } from '../infra/clock.js';
import { describeError } from '../infra/describe-error.js';
import type { Tracing } from '../infra/tracing.js';

/** Uma mensagem da fila já validada, com a identidade dela na rodada. */
export interface PushJob {
  key: string;
  job: PushJobMessage;
  /** `traceparent` propagado pela API (com o OTel ligado). */
  trace?: Record<string, string>;
}

/** `done`: apagar da fila. `retry`: deixar voltar (o Expo falhou); na 3ª vez, a DLQ. */
export type PushOutcome = 'done' | 'retry';

/** O Expo diz que o aparelho não recebe mais push (app desinstalado, permissão retirada). */
export const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

interface Planned {
  key: string;
  tokenId: string;
  push: OutgoingPush;
}

/**
 * Envio do push (ADR 0011; histórias 6.5 e 6.6). Para cada mensagem da rodada: relê o banco
 * (`loadPushContent`), pega os tokens ativos da conta e monta o push curto. A rodada inteira vai ao
 * Expo num lote (o sender divide em lotes de 100). Tickets `ok` ficam guardados para a consulta dos
 * recibos; `DeviceNotRegistered` desativa o token na hora (6.5 CA3). Se o Expo estiver fora do ar,
 * as mensagens voltam para a fila (3 tentativas e DLQ, 6.5 CA4); a notificação no app não depende
 * disto.
 */
export class PushJobHandler {
  private readonly logger = new Logger(PushJobHandler.name);

  constructor(
    private readonly db: Database,
    private readonly sender: PushSender,
    private readonly clock: Clock,
    private readonly tracing: Tracing,
  ) {}

  async handleBatch(jobs: readonly PushJob[]): Promise<Map<string, PushOutcome>> {
    const outcomes = new Map<string, PushOutcome>(jobs.map((item) => [item.key, 'done']));
    const now = this.clock.now();
    const planned: Planned[] = [];
    for (const item of jobs) {
      const content = await loadPushContent(this.db, item.job, now);
      if (content === null) {
        continue;
      }
      for (const token of await activePushTokens(this.db, content.recipientId, now)) {
        planned.push({ key: item.key, tokenId: token.id, push: toPush(content, token.expoToken) });
      }
    }
    if (planned.length === 0) {
      return outcomes;
    }

    let tickets: PushTicket[];
    try {
      tickets = await this.tracing.span(
        'expo.push.send',
        { 'messaging.batch.message_count': planned.length },
        () => this.sender.send(planned.map((item) => item.push)),
        jobs.find((item) => item.trace !== undefined)?.trace,
      );
    } catch (error) {
      this.logger.warn(
        `Expo Push indisponível (${String(planned.length)} push): ${describeError(error)}`,
      );
      for (const item of planned) {
        outcomes.set(item.key, 'retry');
      }
      return outcomes;
    }

    for (const [index, ticket] of tickets.entries()) {
      const item = planned[index];
      if (item === undefined) {
        continue;
      }
      await this.recordTicket(item.tokenId, ticket, now);
    }
    return outcomes;
  }

  private async recordTicket(tokenId: string, ticket: PushTicket, now: Date): Promise<void> {
    if (ticket.status === 'ok') {
      await this.db
        .insert(pushTickets)
        .values({ ticketId: ticket.id, pushTokenId: tokenId, createdAt: now })
        .onConflictDoNothing();
      return;
    }
    if (ticket.error === DEVICE_NOT_REGISTERED) {
      await disablePushToken(this.db, tokenId, now);
      return;
    }
    // MessageTooBig, MessageRateExceeded, InvalidCredentials…: só o código vai para o log.
    this.logger.warn(`Push recusado pelo Expo: ${ticket.error ?? 'erro sem código'}`);
  }
}

/** Desativa o token (6.5 CA3); o job de manutenção apaga os desativados depois de 30 dias. */
export async function disablePushToken(db: Database, tokenId: string, now: Date): Promise<void> {
  await db.update(pushTokens).set({ disabledAt: now }).where(eq(pushTokens.id, tokenId));
}

function toPush(content: PushContent, expoToken: string): OutgoingPush {
  return {
    to: expoToken,
    body: content.body,
    data: { type: content.kind, url: content.url },
    priority: content.priority,
    ...(content.ttlS === undefined ? {} : { ttlS: content.ttlS }),
    ...(content.collapseKey === undefined ? {} : { collapseKey: content.collapseKey }),
  };
}
