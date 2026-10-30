// Integração do consumidor media-jobs (história 2.3, ADR 0009; MID-04, 05, 06, 09, 10 e 13) com as
// migrations reais (Postgres do compose ou PGlite), o S3 e a fila em memória e as fixtures geradas
// pelo sharp na hora.
import { avatarUploads, eq, postMedia, posts, users } from '@sussurro/db';
import {
  createPost,
  createTestDatabase,
  createUser,
  type TestDatabase,
} from '@sussurro/db/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  HTML_AS_JPEG,
  jpegSegments,
  jpegWithEverything,
  metadataTraces,
  pngBomb,
  pngWithMetadata,
  rotated90Jpeg,
  SVG_AS_JPEG,
  webpWithMetadata,
} from './fixtures/media.js';
import { avatarKey, MediaJobHandler, postMediaKeys } from '../src/media/media-job.handler.js';
import { MediaJobsConsumer } from '../src/media/media-jobs.consumer.js';
import { PassthroughVideoProcessor } from '../src/media/passthrough-video-processor.js';
import { FakeClock } from '../src/testing/fake-clock.js';
import { InMemoryQueue } from '../src/testing/in-memory-queue.js';
import { InMemoryObjectStorage } from '../src/testing/in-memory-storage.js';

let testDb: TestDatabase;
const storage = new InMemoryObjectStorage();
const clock = new FakeClock();
const LIMITS = { maxPixels: 40_000_000 };

let fixtures: { jpeg: Buffer; png: Buffer; webp: Buffer; rotated: Buffer };

beforeAll(async () => {
  testDb = await createTestDatabase();
  fixtures = {
    jpeg: await jpegWithEverything(),
    png: await pngWithMetadata(),
    webp: await webpWithMetadata(),
    rotated: await rotated90Jpeg(),
  };
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.truncate();
  storage.clear();
  clock.set(new Date('2026-10-29T12:00:00.000Z'));
});

function handler() {
  return new MediaJobHandler(
    testDb.db,
    storage,
    clock,
    LIMITS,
    new PassthroughVideoProcessor(storage, LIMITS),
  );
}

/** Post `processing` com uma imagem por arquivo, já enviada a `incoming/`. */
async function processingPost(files: { body: Buffer; mime: string }[]) {
  const author = await createUser(testDb.db);
  const post = await createPost(testDb.db, author, {
    type: 'photo',
    status: 'processing',
    mediaCount: files.length,
  });
  for (const [index, file] of files.entries()) {
    const media = post.media[index]!;
    await testDb.db.update(postMedia).set({ mime: file.mime }).where(eq(postMedia.id, media.id));
    storage.objects.set(media.incomingKey, { body: file.body, contentType: file.mime });
  }
  return { author, post };
}

async function mediaRows(postId: string) {
  return testDb.db
    .select()
    .from(postMedia)
    .where(eq(postMedia.postId, postId))
    .orderBy(postMedia.position);
}

async function postStatus(postId: string) {
  const [row] = await testDb.db.select().from(posts).where(eq(posts.id, postId));
  return row!;
}

const attempt = { attempt: 1, maxAttempts: 3 };

describe('fotos de post: metadados, orientação e saídas (MID-05)', () => {
  it('as fixtures de entrada têm mesmo EXIF, GPS, XMP e IPTC (o teste não passa à toa)', async () => {
    const jpeg = await sharp(fixtures.jpeg).metadata();
    expect(jpeg.exif).toBeDefined();
    expect(jpeg.xmp).toBeDefined();
    expect(jpeg.iptc).toBeDefined();
    expect(metadataTraces(fixtures.jpeg)).toEqual(
      expect.arrayContaining(['APP1 Exif', 'xmpmeta', 'IPTC/Photoshop', 'make', 'city', 'xmp']),
    );
    expect(jpegSegments(fixtures.jpeg)).toEqual(expect.arrayContaining(['E1', 'ED']));
    for (const buffer of [fixtures.png, fixtures.webp]) {
      const metadata = await sharp(buffer).metadata();
      expect(metadata.exif).toBeDefined();
      expect(metadata.xmp).toBeDefined();
    }
    expect((await sharp(fixtures.rotated).metadata()).orientation).toBe(6);
  });

  it.each([
    ['jpeg-gps.jpg', 'jpeg', 'image/jpeg'],
    ['png-exif.png', 'png', 'image/png'],
    ['webp-exif.webp', 'webp', 'image/webp'],
  ] as const)(
    '[MID-05] %s: full (1080) e thumb (360) em JPEG sem EXIF, GPS, XMP, IPTC nem ICC',
    async (_name, key, mime) => {
      const { post } = await processingPost([{ body: fixtures[key], mime }]);
      const [media] = post.media;
      await expect(
        handler().handle({ type: 'post-media', mediaId: media!.id }, attempt),
      ).resolves.toBe('done');

      const keys = postMediaKeys(media!.id);
      for (const [outputKey, width] of [
        [keys.full, 1080],
        [keys.thumb, 360],
      ] as const) {
        const output = storage.objects.get(outputKey);
        expect(output?.contentType).toBe('image/jpeg');
        const metadata = await sharp(output!.body).metadata();
        expect(metadata).toMatchObject({ format: 'jpeg', width });
        expect(metadata.exif).toBeUndefined();
        expect(metadata.xmp).toBeUndefined();
        expect(metadata.iptc).toBeUndefined();
        expect(metadata.icc).toBeUndefined();
        expect(metadataTraces(output!.body)).toEqual([]);
        expect(jpegSegments(output!.body).filter((marker) => /^E[1-9A-F]$/.test(marker))).toEqual(
          [],
        );
      }
      const [row] = await mediaRows(post.id);
      expect(row).toMatchObject({
        status: 'ready',
        storageKey: keys.full,
        thumbKey: keys.thumb,
        width: 1080,
        height: 810,
        error: null,
      });
      // CA6 (2.3): o original sai de incoming/.
      expect(storage.objects.has(media!.incomingKey)).toBe(false);
      expect(await postStatus(post.id)).toMatchObject({
        status: 'published',
        publishedAt: clock.now(),
      });
    },
  );

  it('[MID-05] CA3 (2.3): foto com orientação EXIF de 90° sai em pé, sem a tag', async () => {
    const { post } = await processingPost([{ body: fixtures.rotated, mime: 'image/jpeg' }]);
    await handler().handle({ type: 'post-media', mediaId: post.media[0]!.id }, attempt);
    const output = storage.objects.get(postMediaKeys(post.media[0]!.id).full)!.body;
    const metadata = await sharp(output).metadata();
    // 400×200 deitada → 200×400 em pé (sem aumentar: menor que 1080).
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 200, height: 400 });
    expect(metadata.orientation).toBeUndefined();
    const { data } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray((y * 200 + x) * 3, (y * 200 + x) * 3 + 3),
    ];
    const [topRed, , topBlue] = pixel(100, 50);
    const [bottomRed, , bottomBlue] = pixel(100, 350);
    expect(topRed).toBeGreaterThan(200);
    expect(topBlue).toBeLessThan(60);
    expect(bottomBlue).toBeGreaterThan(200);
    expect(bottomRed).toBeLessThan(60);
  });

  it('[MID-09] com 3 imagens o post só vira published quando a última fica pronta', async () => {
    const { post } = await processingPost([
      { body: fixtures.jpeg, mime: 'image/jpeg' },
      { body: fixtures.png, mime: 'image/png' },
      { body: fixtures.webp, mime: 'image/webp' },
    ]);
    const jobs = handler();
    await jobs.handle({ type: 'post-media', mediaId: post.media[0]!.id }, attempt);
    await jobs.handle({ type: 'post-media', mediaId: post.media[1]!.id }, attempt);
    expect((await postStatus(post.id)).status).toBe('processing');
    await jobs.handle({ type: 'post-media', mediaId: post.media[2]!.id }, attempt);
    expect((await postStatus(post.id)).status).toBe('published');
  });

  it('mensagem repetida (entrega dupla do SQS) é idempotente', async () => {
    const { post } = await processingPost([{ body: fixtures.jpeg, mime: 'image/jpeg' }]);
    const jobs = handler();
    const message = { type: 'post-media', mediaId: post.media[0]!.id } as const;
    await jobs.handle(message, attempt);
    const publishedAt = (await postStatus(post.id)).publishedAt;
    clock.advance(60_000);
    await expect(jobs.handle(message, attempt)).resolves.toBe('done');
    expect((await postStatus(post.id)).publishedAt).toEqual(publishedAt);
  });
});

describe('arquivos perigosos (MID-04, MID-06)', () => {
  it.each([
    ['HTML', HTML_AS_JPEG],
    ['SVG', SVG_AS_JPEG],
  ])('[MID-04] %s declarado como JPEG → failed, nada é servido', async (_name, body) => {
    const { post } = await processingPost([{ body, mime: 'image/jpeg' }]);
    const media = post.media[0]!;
    await expect(
      handler().handle({ type: 'post-media', mediaId: media.id }, attempt),
    ).resolves.toBe('done');
    const [row] = await mediaRows(post.id);
    expect(row).toMatchObject({ status: 'failed', storageKey: null, thumbKey: null });
    expect(row?.error).toContain('magic bytes');
    expect((await postStatus(post.id)).status).toBe('failed');
    expect([...storage.objects.keys()].filter((key) => key.startsWith('media/'))).toEqual([]);
    expect(storage.objects.has(media.incomingKey)).toBe(false);
  });

  it('PNG de verdade declarado como JPEG → failed (o tipo real precisa bater)', async () => {
    const { post } = await processingPost([{ body: fixtures.png, mime: 'image/jpeg' }]);
    await handler().handle({ type: 'post-media', mediaId: post.media[0]!.id }, attempt);
    expect((await mediaRows(post.id))[0]?.status).toBe('failed');
  });

  it('[MID-06] PNG de 30000×30000 px → failed pelo limite de pixels, sem derrubar o worker', async () => {
    const bomb = pngBomb();
    expect(bomb.length).toBeLessThan(1_000_000);
    const header = await sharp(bomb, { limitInputPixels: false }).metadata();
    expect({ width: header.width, height: header.height }).toEqual({
      width: 30_000,
      height: 30_000,
    });

    const { post } = await processingPost([{ body: bomb, mime: 'image/png' }]);
    const before = process.memoryUsage().rss;
    await expect(
      handler().handle({ type: 'post-media', mediaId: post.media[0]!.id }, attempt),
    ).resolves.toBe('done');
    const [row] = await mediaRows(post.id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/acima do limite de 40000000 px/);
    // Não decodificou os 900 milhões de pixels.
    expect(process.memoryUsage().rss - before).toBeLessThan(500 * 1024 * 1024);
  });

  it('original ausente em incoming/ → failed (não adianta tentar de novo)', async () => {
    const { post } = await processingPost([{ body: fixtures.jpeg, mime: 'image/jpeg' }]);
    storage.objects.clear();
    await handler().handle({ type: 'post-media', mediaId: post.media[0]!.id }, attempt);
    expect((await mediaRows(post.id))[0]?.status).toBe('failed');
  });
});

describe('falhas transitórias, 3 tentativas e DLQ (MID-10)', () => {
  it('[MID-10] S3 fora nas 3 entregas → failed na 3ª e a mensagem vai para a DLQ', async () => {
    const { post } = await processingPost([
      { body: fixtures.jpeg, mime: 'image/jpeg' },
      { body: fixtures.png, mime: 'image/png' },
    ]);
    const queue = new InMemoryQueue({ visibilityTimeoutMs: 1_000, maxReceiveCount: 3 });
    const consumer = new MediaJobsConsumer(queue, handler(), {
      concurrency: 2,
      waitTimeSeconds: 0,
      maxAttempts: 3,
    });
    queue.send({ type: 'post-media', mediaId: post.media[0]!.id });

    for (let delivery = 1; delivery <= 3; delivery++) {
      storage.failGets = 1;
      expect(await consumer.pollOnce()).toBe(1);
      const [row] = await mediaRows(post.id);
      expect(row?.status).toBe(delivery < 3 ? 'processing' : 'failed');
      queue.advance(1_001);
    }
    // 1 de 2 imagens falhou → o post inteiro falha (o app mostra "Tentar de novo").
    expect((await postStatus(post.id)).status).toBe('failed');
    expect(await consumer.pollOnce()).toBe(0);
    expect(queue.deadLetters).toHaveLength(1);
    expect(queue.deadLetters[0]?.receiveCount).toBe(3);
    expect(queue.pending).toBe(0);
  });

  it('falha transitória seguida de sucesso: a 2ª entrega publica', async () => {
    const { post } = await processingPost([{ body: fixtures.jpeg, mime: 'image/jpeg' }]);
    const queue = new InMemoryQueue({ visibilityTimeoutMs: 1_000 });
    const consumer = new MediaJobsConsumer(queue, handler(), {
      concurrency: 1,
      waitTimeSeconds: 0,
      maxAttempts: 3,
    });
    queue.send({ type: 'post-media', mediaId: post.media[0]!.id });
    storage.failGets = 1;
    await consumer.pollOnce();
    expect(queue.pending).toBe(1);
    queue.advance(1_001);
    await consumer.pollOnce();
    expect(queue.pending).toBe(0);
    expect((await postStatus(post.id)).status).toBe('published');
    expect(queue.deadLetters).toEqual([]);
  });

  it('mensagem fora do formato fica para a DLQ sem derrubar o consumidor', async () => {
    const queue = new InMemoryQueue({ visibilityTimeoutMs: 0, maxReceiveCount: 3 });
    const consumer = new MediaJobsConsumer(queue, handler(), {
      concurrency: 1,
      waitTimeSeconds: 0,
      maxAttempts: 3,
    });
    queue.send('isto não é json');
    for (let index = 0; index < 4; index++) {
      await consumer.pollOnce();
    }
    expect(queue.deadLetters).toHaveLength(1);
  });

  it('o consumidor em segundo plano processa e para limpo', async () => {
    const { post } = await processingPost([{ body: fixtures.jpeg, mime: 'image/jpeg' }]);
    const queue = new InMemoryQueue();
    const consumer = new MediaJobsConsumer(queue, handler(), {
      concurrency: 1,
      waitTimeSeconds: 0,
      maxAttempts: 3,
      idleDelayMs: 10,
    });
    queue.send({ type: 'post-media', mediaId: post.media[0]!.id });
    consumer.start();
    for (let index = 0; index < 100 && queue.pending > 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await consumer.stop();
    expect(consumer.active).toBe(false);
    expect((await postStatus(post.id)).status).toBe('published');
  });
});

describe('foto de perfil (2.4, MID-13)', () => {
  async function avatarUpload(body: Buffer, mime: string, requestedAt: Date) {
    const user = await createUser(testDb.db);
    return { user, upload: await addUpload(user.id, body, mime, requestedAt) };
  }

  async function addUpload(userId: string, body: Buffer, mime: string, requestedAt: Date) {
    const id = crypto.randomUUID();
    const incomingKey = `incoming/${userId}/${id}`;
    await testDb.db.insert(avatarUploads).values({
      id,
      userId,
      mime,
      sizeBytes: body.length,
      incomingKey,
      status: 'processing',
      requestedAt,
    });
    storage.objects.set(incomingKey, { body, contentType: mime });
    return { id, incomingKey };
  }

  it('[MID-13] mesmo pipeline: quadrado de 400 px, sem metadados; vira o avatar da conta', async () => {
    const { user, upload } = await avatarUpload(fixtures.jpeg, 'image/jpeg', clock.now());
    await expect(handler().handle({ type: 'avatar', uploadId: upload.id }, attempt)).resolves.toBe(
      'done',
    );
    const output = storage.objects.get(avatarKey(upload.id))!.body;
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 400, height: 400 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(metadataTraces(output)).toEqual([]);
    const [account] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    expect(account?.avatarKey).toBe(avatarKey(upload.id));
    expect(storage.objects.has(upload.incomingKey)).toBe(false);
  });

  it('[MID-13] SVG declarado como JPEG → failed e o avatar não muda', async () => {
    const { user, upload } = await avatarUpload(SVG_AS_JPEG, 'image/jpeg', clock.now());
    await handler().handle({ type: 'avatar', uploadId: upload.id }, attempt);
    const [row] = await testDb.db
      .select()
      .from(avatarUploads)
      .where(eq(avatarUploads.id, upload.id));
    expect(row?.status).toBe('failed');
    const [account] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    expect(account?.avatarKey).toBeNull();
  });

  it('troca nova substitui a antiga e apaga o objeto anterior; a mais antiga que termina depois não vence', async () => {
    const { user, upload: older } = await avatarUpload(fixtures.png, 'image/png', clock.now());
    const newer = await addUpload(
      user.id,
      fixtures.jpeg,
      'image/jpeg',
      new Date(clock.now().getTime() + 1_000),
    );
    const jobs = handler();
    await jobs.handle({ type: 'avatar', uploadId: newer.id }, attempt);
    await jobs.handle({ type: 'avatar', uploadId: older.id }, attempt);
    const [account] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    expect(account?.avatarKey).toBe(avatarKey(newer.id));
    expect(storage.objects.has(avatarKey(older.id))).toBe(false);

    const third = await addUpload(
      user.id,
      fixtures.webp,
      'image/webp',
      new Date(clock.now().getTime() + 2_000),
    );
    await jobs.handle({ type: 'avatar', uploadId: third.id }, attempt);
    expect(storage.objects.has(avatarKey(newer.id))).toBe(false);
    expect(storage.objects.has(avatarKey(third.id))).toBe(true);
  });
});
