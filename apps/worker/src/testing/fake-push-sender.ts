import { randomUUID } from 'node:crypto';

import {
  type OutgoingPush,
  type PushReceipt,
  PushSender,
  type PushTicket,
} from '../push/push-sender.js';

/**
 * Fake do Expo Push nos testes (nenhuma chamada sai da máquina): guarda os lotes enviados e
 * devolve tickets `ok`, a menos que o teste ligue o "fora do ar", marque tokens como
 * `DeviceNotRegistered` no envio ou programe recibos.
 */
export class FakePushSender extends PushSender {
  readonly batches: OutgoingPush[][] = [];
  /** Envio e recibos falham (Expo fora do ar). */
  down = false;
  /** Tokens cujo ticket volta `DeviceNotRegistered` no próprio envio. */
  readonly unregistered = new Set<string>();
  /** Recibos programados por id de ticket; sem entrada = ainda não pronto. */
  readonly receiptsById = new Map<string, PushReceipt>();
  /** Ticket emitido para cada token (para programar o recibo). */
  readonly ticketOf = new Map<string, string>();

  get sent(): OutgoingPush[] {
    return this.batches.flat();
  }

  send(messages: readonly OutgoingPush[]): Promise<PushTicket[]> {
    if (this.down) {
      return Promise.reject(new Error('Expo Push indisponível (simulado)'));
    }
    this.batches.push([...messages]);
    return Promise.resolve(
      messages.map((message): PushTicket => {
        if (this.unregistered.has(message.to)) {
          return {
            status: 'error',
            error: 'DeviceNotRegistered',
            message: 'o aparelho não está mais registrado',
          };
        }
        const id = `ticket-${randomUUID()}`;
        this.ticketOf.set(message.to, id);
        return { status: 'ok', id };
      }),
    );
  }

  receipts(ticketIds: readonly string[]): Promise<Map<string, PushReceipt>> {
    if (this.down) {
      return Promise.reject(new Error('Expo Push indisponível (simulado)'));
    }
    return Promise.resolve(
      new Map(
        ticketIds.flatMap((id) => {
          const receipt = this.receiptsById.get(id);
          return receipt === undefined ? [] : [[id, receipt] as const];
        }),
      ),
    );
  }

  clear(): void {
    this.batches.length = 0;
    this.down = false;
    this.unregistered.clear();
    this.receiptsById.clear();
    this.ticketOf.clear();
  }
}
