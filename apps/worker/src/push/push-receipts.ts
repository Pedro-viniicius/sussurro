import { type Database, lt, pushTickets, sql } from '@sussurro/db';

import { DEVICE_NOT_REGISTERED, disablePushToken } from './push-job.handler.js';
import type { PushSender } from './push-sender.js';

/** O Expo libera o recibo depois da entrega; a documentação sugere esperar cerca de 15 min. */
export const RECEIPT_DELAY_MS = 15 * 60 * 1000;
/** Depois de um dia o Expo não guarda mais o recibo: o ticket sai. */
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Tickets por rodada (o SDK consulta o Expo em lotes de 300 ids). */
export const RECEIPTS_BATCH_SIZE = 1_000;

export interface ReceiptsResult {
  checked: number;
  /** Tokens desativados por `DeviceNotRegistered` (6.5 CA3). */
  disabledTokens: number;
  /** Recibos que ainda não estavam prontos (voltam para a próxima rodada). */
  pending: number;
  /** Tickets com mais de um dia, sem recibo, descartados. */
  expired: number;
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

/**
 * Consulta dos recibos do Expo Push (ADR 0011), a cada `PUSH_RECEIPTS_INTERVAL_MS`. Os tickets
 * com mais de 15 min são reservados com `DELETE … FOR UPDATE SKIP LOCKED` (duas réplicas não pegam
 * o mesmo); os recibos `DeviceNotRegistered` desativam o token; os que ainda não ficaram prontos
 * voltam para a tabela. Se o Expo estiver fora do ar, todos voltam (tenta na próxima rodada).
 */
export async function checkPushReceipts(
  db: Database,
  sender: PushSender,
  now: Date,
): Promise<ReceiptsResult> {
  const expired = await db
    .delete(pushTickets)
    .where(lt(pushTickets.createdAt, new Date(now.getTime() - RECEIPT_MAX_AGE_MS)))
    .returning({ ticketId: pushTickets.ticketId });
  const ready = new Date(now.getTime() - RECEIPT_DELAY_MS).toISOString();
  const claimed = rowsOf<{ ticketId: string; pushTokenId: string; createdAt: Date | string }>(
    await db.execute(sql`
      delete from push_tickets
       where ticket_id in (
         select ticket_id from push_tickets
          where created_at <= ${ready}::timestamptz
          order by created_at
          limit ${RECEIPTS_BATCH_SIZE}
          for update skip locked)
      returning ticket_id as "ticketId", push_token_id as "pushTokenId", created_at as "createdAt"`),
  );
  if (claimed.length === 0) {
    return { checked: 0, disabledTokens: 0, pending: 0, expired: expired.length };
  }

  const restore = async (rows: typeof claimed) => {
    if (rows.length > 0) {
      await db
        .insert(pushTickets)
        .values(
          rows.map((row) => ({
            ticketId: row.ticketId,
            pushTokenId: row.pushTokenId,
            createdAt: new Date(row.createdAt),
          })),
        )
        .onConflictDoNothing();
    }
  };

  let receipts;
  try {
    receipts = await sender.receipts(claimed.map((row) => row.ticketId));
  } catch (error) {
    await restore(claimed);
    throw error;
  }

  const disabled = new Set<string>();
  for (const row of claimed) {
    const receipt = receipts.get(row.ticketId);
    if (receipt?.status === 'error' && receipt.error === DEVICE_NOT_REGISTERED) {
      disabled.add(row.pushTokenId);
    }
  }
  for (const tokenId of disabled) {
    await disablePushToken(db, tokenId, now);
  }
  const pending = claimed.filter((row) => !receipts.has(row.ticketId));
  await restore(pending.filter((row) => !disabled.has(row.pushTokenId)));
  return {
    checked: claimed.length,
    disabledTokens: disabled.size,
    pending: pending.length,
    expired: expired.length,
  };
}
