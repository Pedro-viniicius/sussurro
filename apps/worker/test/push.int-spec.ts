// Integração do push (Fase 6; ADR 0011; histórias 6.5 e 6.6; NOT-08) com as migrations reais
// (Postgres do compose ou PGlite), a fila em memória (visibility timeout, 3 entregas e DLQ) e um
// fake do Expo Push: nenhuma chamada sai da máquina.
import { randomUUID } from 'node:crypto';

import {
  connectionRequests,
  eq,
  notifications,
  posts,
  pushTickets,
  pushTokens,
  refreshTokens,
  type UserRow,
} from '@sussurro/db';
import {
  addComment,
  block,
  connect,
  createPost,
  createTestDatabase,
  createUser,
  type TestDatabase,
} from '@sussurro/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Tracing } from '../src/infra/tracing.js';
import { purgeNotificationsAndPushTokens } from '../src/jobs/maintenance.js';
import { PushJobHandler } from '../src/push/push-job.handler.js';
import { checkPushReceipts } from '../src/push/push-receipts.js';
import { PushConsumer } from '../src/push/push.consumer.js';
import { FakeClock } from '../src/testing/fake-clock.js';
import { FakePushSender } from '../src/testing/fake-push-sender.js';
import { InMemoryQueue } from '../src/testing/in-memory-queue.js';

let testDb: TestDatabase;
const clock = new FakeClock();
const sender = new FakePushSender();
let queue: InMemoryQueue;
let consumer: PushConsumer;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.truncate();
  sender.clear();
  clock.set(new Date('2026-10-30T12:00:00.000Z'));
  queue = new InMemoryQueue({ visibilityTimeoutMs: MINUTE, maxReceiveCount: 3 });
  consumer = new PushConsumer(
    queue,
    new PushJobHandler(testDb.db, sender, clock, new Tracing(false)),
    { concurrency: 10, waitTimeSeconds: 0, maxAttempts: 3 },
  );
});

/** Sessão viva (família de refresh) e o push token do aparelho dela. */
async function device(user: UserRow, token: string, options: { revoked?: boolean } = {}) {
  const familyId = randomUUID();
  await testDb.db.insert(refreshTokens).values({
    userId: user.id,
    familyId,
    tokenHash: new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
    expiresAt: new Date(clock.now().getTime() + 30 * DAY),
    revokedAt: options.revoked === true ? clock.now() : null,
  });
  const [row] = await testDb.db
    .insert(pushTokens)
    .values({
      userId: user.id,
      expoToken: token,
      platform: 'ios',
      refreshFamilyId: familyId,
      createdAt: clock.now(),
      lastSeenAt: clock.now(),
    })
    .returning();
  return row!;
}

async function notification(
  values: Partial<typeof notifications.$inferInsert> & { recipientId: string },
) {
  const [row] = await testDb.db
    .insert(notifications)
    .values({ type: 'post_liked', createdAt: clock.now(), updatedAt: clock.now(), ...values })
    .returning();
  return row!;
}

function enqueueNotification(id: string, attributes: Record<string, string> = {}) {
  return queue.send({ type: 'notification', notificationId: id }, attributes);
}

describe('envio do push (6.5)', () => {
  it('[NOT-08] [6.5 CA1] comentário: texto curto, sem a íntegra; data só com o tipo e a rota; ticket guardado', async () => {
    const ana = await createUser(testDb.db);
    const lucas = await createUser(testDb.db, { handle: 'lucasf_push' });
    await connect(testDb.db, ana, lucas);
    const post = await createPost(testDb.db, ana, { type: 'photo' });
    const body = 'Que luz bonita! Comentário inteiro que nunca pode sair no push.';
    const comment = await addComment(testDb.db, post, lucas, { body });
    const token = await device(ana, 'ExponentPushToken[ana-iphone-001]');
    const row = await notification({
      recipientId: ana.id,
      actorId: lucas.id,
      postId: post.id,
      commentId: comment.id,
      type: 'post_commented',
    });
    enqueueNotification(row.id);

    expect(await consumer.pollOnce()).toBe(1);
    expect(sender.sent).toEqual([
      {
        to: 'ExponentPushToken[ana-iphone-001]',
        body: 'lucasf_push comentou na sua foto.',
        data: { type: 'post_commented', url: '/pessoal/inicio/notificacoes' },
        priority: 'default',
      },
    ]);
    expect(JSON.stringify(sender.batches)).not.toContain('Que luz bonita');
    expect(queue.pending).toBe(0);
    const tickets = await testDb.db.select().from(pushTickets);
    expect(tickets).toEqual([
      expect.objectContaining({
        pushTokenId: token.id,
        ticketId: sender.ticketOf.get(token.expoToken),
      }),
    ]);
  });

  it('[NOT-08] [6.5 CA2] seguidores: agregado e anônimo (nada de quem seguiu), abre as Notificações do criador', async () => {
    const creator = await createUser(testDb.db, { accountType: 'creator' });
    const follower = await createUser(testDb.db, { handle: 'canary_follower_push' });
    await device(creator, 'ExponentPushToken[criador-android-1]');
    const row = await notification({
      recipientId: creator.id,
      type: 'new_followers',
      bucketKey: 'nf:2026-10-30',
      count: 3,
    });
    enqueueNotification(row.id);
    await consumer.pollOnce();
    expect(sender.sent).toEqual([
      expect.objectContaining({
        body: '3 novas pessoas começaram a seguir você.',
        data: { type: 'new_followers', url: '/criador/notificacoes' },
        collapseKey: `nf-${row.id}`,
      }),
    ]);
    const everything = JSON.stringify(sender.batches);
    expect(everything).not.toContain(follower.handle);
    expect(everything).not.toContain(follower.id);
  });

  it('envia para todos os aparelhos ativos da conta, numa rodada só ao Expo (lote)', async () => {
    const author = await createUser(testDb.db, { accountType: 'creator' });
    const fans = [await createUser(testDb.db), await createUser(testDb.db)];
    const post = await createPost(testDb.db, author, { type: 'reel' });
    await device(author, 'ExponentPushToken[aparelho-a]');
    await device(author, 'ExponentPushToken[aparelho-b]');
    for (const fan of fans) {
      enqueueNotification(
        (await notification({ recipientId: author.id, actorId: fan.id, postId: post.id })).id,
      );
    }
    expect(await consumer.pollOnce()).toBe(2);
    expect(sender.batches).toHaveLength(1);
    expect(sender.sent).toHaveLength(4);
    expect(new Set(sender.sent.map((push) => push.body))).toEqual(
      new Set(fans.map((fan) => `${fan.handle} curtiu seu reel.`)),
    );
  });

  it('não envia: já lida, conta de quem agiu excluída, bloqueio, post apagado, sessão encerrada, token desativado ou notificação que sumiu', async () => {
    const ana = await createUser(testDb.db);
    const bia = await createUser(testDb.db);
    const gone = await createUser(testDb.db, { deletedAt: clock.now() });
    const blocked = await createUser(testDb.db);
    await connect(testDb.db, ana, bia);
    await connect(testDb.db, ana, blocked);
    await block(testDb.db, ana, blocked);
    const post = await createPost(testDb.db, ana);
    const deletedPost = await createPost(testDb.db, ana, { deletedAt: clock.now() });
    await device(ana, 'ExponentPushToken[ana-viva]');
    const cases = [
      await notification({
        recipientId: ana.id,
        actorId: bia.id,
        postId: post.id,
        readAt: clock.now(),
      }),
      await notification({ recipientId: ana.id, actorId: gone.id, postId: post.id }),
      await notification({ recipientId: ana.id, actorId: blocked.id, postId: post.id }),
      await notification({ recipientId: ana.id, actorId: bia.id, postId: deletedPost.id }),
    ];
    for (const row of cases) {
      enqueueNotification(row.id);
    }
    enqueueNotification(randomUUID());
    await consumer.pollOnce();
    expect(sender.sent).toEqual([]);
    expect(queue.pending).toBe(0);

    // Sessão revogada ou token desativado: nenhum aparelho para receber.
    const carla = await createUser(testDb.db);
    await connect(testDb.db, carla, bia);
    const carlaPost = await createPost(testDb.db, carla);
    await device(carla, 'ExponentPushToken[carla-revogada]', { revoked: true });
    const disabled = await device(carla, 'ExponentPushToken[carla-desativada]');
    await testDb.db
      .update(pushTokens)
      .set({ disabledAt: clock.now() })
      .where(eq(pushTokens.id, disabled.id));
    enqueueNotification(
      (await notification({ recipientId: carla.id, actorId: bia.id, postId: carlaPost.id })).id,
    );
    await consumer.pollOnce();
    expect(sender.sent).toEqual([]);
  });

  it('[NOT-08] [6.5 CA3] DeviceNotRegistered no envio desativa o token na hora', async () => {
    const ana = await createUser(testDb.db, { accountType: 'creator' });
    const bia = await createUser(testDb.db);
    const post = await createPost(testDb.db, ana);
    const dead = await device(ana, 'ExponentPushToken[desinstalado]');
    const alive = await device(ana, 'ExponentPushToken[instalado]');
    sender.unregistered.add(dead.expoToken);
    enqueueNotification(
      (await notification({ recipientId: ana.id, actorId: bia.id, postId: post.id })).id,
    );
    await consumer.pollOnce();
    const rows = await testDb.db.select().from(pushTokens);
    expect(rows.find((row) => row.id === dead.id)?.disabledAt).toEqual(clock.now());
    expect(rows.find((row) => row.id === alive.id)?.disabledAt).toBeNull();
    expect((await testDb.db.select().from(pushTickets)).map((row) => row.pushTokenId)).toEqual([
      alive.id,
    ]);
  });

  it('[6.5 CA4] Expo fora do ar: a mensagem volta, 3 tentativas e DLQ; a notificação continua no banco', async () => {
    const ana = await createUser(testDb.db, { accountType: 'creator' });
    const bia = await createUser(testDb.db);
    const post = await createPost(testDb.db, ana);
    await device(ana, 'ExponentPushToken[ana-1]');
    const row = await notification({ recipientId: ana.id, actorId: bia.id, postId: post.id });
    enqueueNotification(row.id);
    sender.down = true;
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await consumer.pollOnce()).toBe(1);
      expect(queue.deadLetters).toEqual([]);
      queue.advance(MINUTE + 1);
    }
    expect(await consumer.pollOnce()).toBe(0);
    expect(queue.deadLetters).toHaveLength(1);
    expect(queue.pending).toBe(0);
    expect(await testDb.db.select().from(notifications)).toHaveLength(1);
  });

  it('Expo volta antes da 3ª tentativa: o push sai e a mensagem é apagada', async () => {
    const ana = await createUser(testDb.db, { accountType: 'creator' });
    const bia = await createUser(testDb.db);
    const post = await createPost(testDb.db, ana);
    await device(ana, 'ExponentPushToken[ana-2]');
    enqueueNotification(
      (await notification({ recipientId: ana.id, actorId: bia.id, postId: post.id })).id,
    );
    sender.down = true;
    await consumer.pollOnce();
    sender.down = false;
    queue.advance(MINUTE + 1);
    await consumer.pollOnce();
    expect(sender.sent).toHaveLength(1);
    expect(queue.pending).toBe(0);
    expect(queue.deadLetters).toEqual([]);
  });

  it('mensagem fora do formato (ex.: com o texto do comentário) não é enviada e acaba na DLQ', async () => {
    queue.send({ type: 'notification', notificationId: randomUUID(), body: 'íntegra' });
    queue.send('não é json');
    for (let attempt = 0; attempt < 4; attempt++) {
      await consumer.pollOnce();
      queue.advance(MINUTE + 1);
    }
    expect(sender.sent).toEqual([]);
    expect(queue.deadLetters).toHaveLength(2);
  });
});

describe('push do pedido de conexão (6.6)', () => {
  let sequence = 0;
  async function pendingRequest(createdAt: Date) {
    sequence += 1;
    const lucas = await createUser(testDb.db, { handle: `lucasf_pedido${String(sequence)}` });
    const bia = await createUser(testDb.db);
    await device(bia, `ExponentPushToken[bia-conectar-${String(sequence)}]`);
    const [request] = await testDb.db
      .insert(connectionRequests)
      .values({
        fromId: lucas.id,
        toId: bia.id,
        method: 'ble',
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 120_000),
      })
      .returning();
    return request!;
  }

  it('[6.6 CA1] pendente: "lucasf quer se conectar com você." abre o Conectar, prioridade alta e validade até o fim dos 120 s', async () => {
    const request = await pendingRequest(new Date(clock.now().getTime() - 30_000));
    queue.send({ type: 'connection-request', requestId: request.id });
    await consumer.pollOnce();
    expect(sender.sent).toEqual([
      {
        to: `ExponentPushToken[bia-conectar-${String(sequence)}]`,
        body: `lucasf_pedido${String(sequence)} quer se conectar com você.`,
        data: { type: 'connection_request', url: '/pessoal/conectar' },
        priority: 'high',
        ttlS: 90,
      },
    ]);
  });

  it('vencido, recusado ou com bloqueio: nada é enviado', async () => {
    const expired = await pendingRequest(new Date(clock.now().getTime() - 121_000));
    queue.send({ type: 'connection-request', requestId: expired.id });
    await consumer.pollOnce();
    expect(sender.sent).toEqual([]);

    const declined = await pendingRequest(clock.now());
    await testDb.db
      .update(connectionRequests)
      .set({ status: 'declined', respondedAt: clock.now() })
      .where(eq(connectionRequests.id, declined.id));
    const blockedRequest = await pendingRequest(clock.now());
    await block(testDb.db, { id: blockedRequest.toId }, { id: blockedRequest.fromId });
    queue.send({ type: 'connection-request', requestId: declined.id });
    queue.send({ type: 'connection-request', requestId: blockedRequest.id });
    await consumer.pollOnce();
    expect(sender.sent).toEqual([]);
  });
});

describe('recibos e retenção (6.5 CA3, ADR 0011)', () => {
  it('[NOT-08] [6.5 CA3] recibo DeviceNotRegistered (depois de 15 min) desativa o token; recibo ainda não pronto volta; ticket de mais de 24 h sai', async () => {
    const ana = await createUser(testDb.db, { accountType: 'creator' });
    const bia = await createUser(testDb.db);
    const post = await createPost(testDb.db, ana);
    const iphone = await device(ana, 'ExponentPushToken[ana-iphone]');
    const android = await device(ana, 'ExponentPushToken[ana-android]');
    enqueueNotification(
      (await notification({ recipientId: ana.id, actorId: bia.id, postId: post.id })).id,
    );
    await consumer.pollOnce();
    expect(await testDb.db.select().from(pushTickets)).toHaveLength(2);

    // Antes de 15 min, nada é consultado.
    expect(await checkPushReceipts(testDb.db, sender, clock.now())).toMatchObject({ checked: 0 });
    sender.receiptsById.set(sender.ticketOf.get(iphone.expoToken) ?? '', {
      status: 'error',
      error: 'DeviceNotRegistered',
      message: 'desinstalado',
    });
    clock.advance(16 * MINUTE);
    expect(await checkPushReceipts(testDb.db, sender, clock.now())).toEqual({
      checked: 2,
      disabledTokens: 1,
      pending: 1,
      expired: 0,
    });
    const tokens = await testDb.db.select().from(pushTokens);
    expect(tokens.find((row) => row.id === iphone.id)?.disabledAt).not.toBeNull();
    expect(tokens.find((row) => row.id === android.id)?.disabledAt).toBeNull();
    // O recibo do Android ainda não estava pronto: o ticket voltou.
    expect((await testDb.db.select().from(pushTickets)).map((row) => row.pushTokenId)).toEqual([
      android.id,
    ]);
    clock.advance(DAY);
    expect(await checkPushReceipts(testDb.db, sender, clock.now())).toMatchObject({ expired: 1 });
    expect(await testDb.db.select().from(pushTickets)).toEqual([]);
  });

  it('Expo fora do ar na consulta: os tickets voltam para a próxima rodada', async () => {
    const ana = await createUser(testDb.db, { accountType: 'creator' });
    const bia = await createUser(testDb.db);
    const post = await createPost(testDb.db, ana);
    await device(ana, 'ExponentPushToken[ana-3]');
    enqueueNotification(
      (await notification({ recipientId: ana.id, actorId: bia.id, postId: post.id })).id,
    );
    await consumer.pollOnce();
    clock.advance(16 * MINUTE);
    sender.down = true;
    await expect(checkPushReceipts(testDb.db, sender, clock.now())).rejects.toThrow('indisponível');
    expect(await testDb.db.select().from(pushTickets)).toHaveLength(1);
  });

  it('retenção: notificações com mais de 90 dias, tokens desativados há 30 dias e tokens de sessão encerrada saem', async () => {
    const ana = await createUser(testDb.db, { accountType: 'creator' });
    const bia = await createUser(testDb.db);
    const post = await createPost(testDb.db, ana);
    await notification({
      recipientId: ana.id,
      actorId: bia.id,
      postId: post.id,
      createdAt: new Date(clock.now().getTime() - 91 * DAY),
      updatedAt: new Date(clock.now().getTime() - 91 * DAY),
    });
    const recent = await notification({
      recipientId: ana.id,
      type: 'new_followers',
      bucketKey: 'nf:2026-10-30',
    });
    const alive = await device(ana, 'ExponentPushToken[viva]');
    await device(ana, 'ExponentPushToken[revogada]', { revoked: true });
    const disabled = await device(ana, 'ExponentPushToken[desativada]');
    await testDb.db
      .update(pushTokens)
      .set({ disabledAt: new Date(clock.now().getTime() - 31 * DAY) })
      .where(eq(pushTokens.id, disabled.id));
    expect(await purgeNotificationsAndPushTokens(testDb.db, clock.now())).toEqual({
      notifications: 1,
      pushTokens: 2,
    });
    expect((await testDb.db.select().from(notifications)).map((row) => row.id)).toEqual([
      recent.id,
    ]);
    expect((await testDb.db.select().from(pushTokens)).map((row) => row.id)).toEqual([alive.id]);
    // O post continua (a retenção é só das notificações).
    expect(await testDb.db.select().from(posts)).toHaveLength(1);
  });
});
