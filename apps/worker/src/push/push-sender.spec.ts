import { Logger } from '@nestjs/common';
import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExpoPushSender, LogPushSender, maskPushToken, type OutgoingPush } from './push-sender.js';

const push = (index: number): OutgoingPush => ({
  to: `ExponentPushToken[aparelho-${String(index)}]`,
  body: 'lucasf curtiu sua foto.',
  data: { type: 'post_liked', url: '/pessoal/inicio/notificacoes' },
  priority: 'default',
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Cliente do Expo com o chunking de verdade do SDK e o envio dublado (nenhuma rede). */
function fakeExpo() {
  const real = new Expo();
  const sentChunks: ExpoPushMessage[][] = [];
  const receiptChunks: string[][] = [];
  const client = {
    chunkPushNotifications: (messages: ExpoPushMessage[]) => real.chunkPushNotifications(messages),
    chunkPushNotificationReceiptIds: (ids: string[]) => real.chunkPushNotificationReceiptIds(ids),
    sendPushNotificationsAsync: vi.fn((chunk: ExpoPushMessage[]) => {
      sentChunks.push(chunk);
      return Promise.resolve(
        chunk.map((message, index) =>
          String(message.to).includes('morto')
            ? {
                status: 'error' as const,
                message: 'não registrado',
                details: { error: 'DeviceNotRegistered' as const },
              }
            : { status: 'ok' as const, id: `t-${String(sentChunks.length)}-${String(index)}` },
        ),
      );
    }),
    getPushNotificationReceiptsAsync: vi.fn((ids: string[]) => {
      receiptChunks.push(ids);
      return Promise.resolve(
        Object.fromEntries(
          ids.map((id) => [
            id,
            id.endsWith('-0')
              ? {
                  status: 'error' as const,
                  message: 'x',
                  details: { error: 'DeviceNotRegistered' as const },
                }
              : { status: 'ok' as const },
          ]),
        ),
      );
    }),
  };
  return { client, sentChunks, receiptChunks };
}

describe('ExpoPushSender (6.5)', () => {
  it('envia em lotes de até 100, com som, prioridade, validade e a chave de agrupamento; só o tipo e a rota no data', async () => {
    const { client, sentChunks } = fakeExpo();
    const sender = new ExpoPushSender(client);
    const messages = Array.from({ length: 150 }, (_, index) => push(index));
    messages[0] = { ...messages[0]!, ttlS: 90, priority: 'high', collapseKey: 'nf-1' };
    messages[1] = { ...messages[1]!, to: 'ExponentPushToken[morto]' };
    const tickets = await sender.send(messages);
    expect(sentChunks.map((chunk) => chunk.length)).toEqual([100, 50]);
    expect(sentChunks[0]?.[0]).toEqual({
      to: 'ExponentPushToken[aparelho-0]',
      body: 'lucasf curtiu sua foto.',
      data: { type: 'post_liked', url: '/pessoal/inicio/notificacoes' },
      sound: 'default',
      priority: 'high',
      ttl: 90,
      collapseId: 'nf-1',
      tag: 'nf-1',
    });
    expect(tickets).toHaveLength(150);
    expect(tickets[1]).toEqual({
      status: 'error',
      error: 'DeviceNotRegistered',
      message: 'não registrado',
    });
    expect(tickets[2]).toEqual({ status: 'ok', id: 't-1-2' });
  });

  it('recibos nos lotes do SDK (300 ids por chamada), com o código do erro', async () => {
    const { client, receiptChunks } = fakeExpo();
    const sender = new ExpoPushSender(client);
    const ids = Array.from({ length: 1_200 }, (_, index) => `r-${String(index)}`);
    const receipts = await sender.receipts(ids);
    expect(receiptChunks.map((chunk) => chunk.length)).toEqual([300, 300, 300, 300]);
    expect(receipts.get('r-0')).toEqual({
      status: 'error',
      error: 'DeviceNotRegistered',
      message: 'x',
    });
    expect(receipts.get('r-1')).toEqual({ status: 'ok' });
  });

  it('falha do Expo (rede, 5xx) propaga: a mensagem da fila volta', async () => {
    const { client } = fakeExpo();
    client.sendPushNotificationsAsync.mockRejectedValueOnce(new Error('503'));
    await expect(new ExpoPushSender(client).send([push(1)])).rejects.toThrow('503');
  });
});

describe('LogPushSender (dev) e o token no log', () => {
  it('não sai da máquina: escreve o texto e o token mascarado; recibos sempre ok', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const sender = new LogPushSender();
    const [ticket] = await sender.send([push(7)]);
    expect(ticket).toMatchObject({ status: 'ok' });
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain('lucasf curtiu sua foto.');
    expect(line).not.toContain('aparelho-7');
    expect(await sender.receipts(['a'])).toEqual(new Map([['a', { status: 'ok' }]]));
  });

  it('maskPushToken mostra só o começo e o fim', () => {
    expect(maskPushToken('ExponentPushToken[AbCdEfGhIjKlMn]')).toBe('[AbC…Mn]');
    expect(maskPushToken('ExponentPushToken[curto]')).toBe('[…]');
  });
});
