import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { PushData } from '@sussurro/shared';
import type { Expo, ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';

/** Um push para um aparelho (o texto já é o curto, ADR 0011). */
export interface OutgoingPush {
  /** Push token do Expo (`ExponentPushToken[...]`). */
  to: string;
  body: string;
  data: PushData;
  /** Segundos até o push perder o sentido (pedido de conexão: o que falta dos 120 s). */
  ttlS?: number;
  priority: 'default' | 'high';
  /** Push que substitui o anterior com a mesma chave (seguidores do dia). */
  collapseKey?: string;
}

/** Resposta do envio de um push (na mesma ordem das mensagens). */
export type PushTicket =
  { status: 'ok'; id: string } | { status: 'error'; error: string | undefined; message: string };

/** Recibo de entrega de um ticket (o Expo guarda por cerca de um dia). */
export type PushReceipt =
  { status: 'ok' } | { status: 'error'; error: string | undefined; message: string };

/**
 * Porta do Expo Push (ADR 0011). O Expo em produção; o `log` em dev (nada sai da máquina); um fake
 * nos testes (`src/testing/fake-push-sender.ts`). Nunca chamada nos testes de verdade.
 */
export abstract class PushSender {
  /** Envia em lotes; falha da rede/Expo lança (a mensagem da fila volta e tenta de novo). */
  abstract send(messages: readonly OutgoingPush[]): Promise<PushTicket[]>;
  /** Recibos por id de ticket; ids sem recibo ainda não aparecem no mapa. */
  abstract receipts(ticketIds: readonly string[]): Promise<Map<string, PushReceipt>>;
}

/** Token mascarado para log: só o começo e o fim (o token é uma credencial do aparelho). */
export function maskPushToken(token: string): string {
  const inner = /\[(.*)\]$/.exec(token)?.[1] ?? token;
  return inner.length <= 6 ? '[…]' : `[${inner.slice(0, 3)}…${inner.slice(-2)}]`;
}

function toExpoMessage(message: OutgoingPush): ExpoPushMessage {
  return {
    to: message.to,
    body: message.body,
    data: { ...message.data },
    sound: 'default',
    priority: message.priority,
    ...(message.ttlS === undefined ? {} : { ttl: message.ttlS }),
    ...(message.collapseKey === undefined
      ? {}
      : { collapseId: message.collapseKey, tag: message.collapseKey }),
  };
}

function fromExpoTicket(ticket: ExpoPushTicket): PushTicket {
  return ticket.status === 'ok'
    ? { status: 'ok', id: ticket.id }
    : { status: 'error', error: ticket.details?.error, message: ticket.message };
}

function fromExpoReceipt(receipt: ExpoPushReceipt): PushReceipt {
  return receipt.status === 'ok'
    ? { status: 'ok' }
    : { status: 'error', error: receipt.details?.error, message: receipt.message };
}

type ExpoClient = Pick<
  Expo,
  | 'sendPushNotificationsAsync'
  | 'getPushNotificationReceiptsAsync'
  | 'chunkPushNotifications'
  | 'chunkPushNotificationReceiptIds'
>;

/**
 * Expo Push Service pelo `expo-server-sdk` (ADR 0011): lotes de até 100 mensagens e recibos em
 * lotes de 300 ids (o SDK divide e tenta de novo no 429). O `data` leva só o tipo e a rota.
 */
export class ExpoPushSender extends PushSender {
  constructor(private readonly expo: ExpoClient) {
    super();
  }

  async send(messages: readonly OutgoingPush[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (const chunk of this.expo.chunkPushNotifications(messages.map(toExpoMessage))) {
      const result = await this.expo.sendPushNotificationsAsync(chunk);
      tickets.push(...result.map(fromExpoTicket));
    }
    return tickets;
  }

  async receipts(ticketIds: readonly string[]): Promise<Map<string, PushReceipt>> {
    const receipts = new Map<string, PushReceipt>();
    for (const chunk of this.expo.chunkPushNotificationReceiptIds([...ticketIds])) {
      const result = await this.expo.getPushNotificationReceiptsAsync(chunk);
      for (const [id, receipt] of Object.entries(result)) {
        receipts.set(id, fromExpoReceipt(receipt));
      }
    }
    return receipts;
  }
}

/**
 * Desenvolvimento (`PUSH_SENDER=log`): escreve no log o texto e o token mascarado, sem sair da
 * máquina. Todo envio "dá certo" e todo recibo é `ok`. Recusado em produção.
 */
export class LogPushSender extends PushSender {
  private readonly logger = new Logger('Push (dev)');

  send(messages: readonly OutgoingPush[]): Promise<PushTicket[]> {
    return Promise.resolve(
      messages.map((message) => {
        this.logger.log(
          `Push (dev) para ${maskPushToken(message.to)}: "${message.body}" → ${message.data.url}`,
        );
        return { status: 'ok' as const, id: `log-${randomUUID()}` };
      }),
    );
  }

  receipts(ticketIds: readonly string[]): Promise<Map<string, PushReceipt>> {
    return Promise.resolve(new Map(ticketIds.map((id) => [id, { status: 'ok' as const }])));
  }
}
