// Integração do vídeo dos reels (histórias 5.1, 5.2 e 5.6; ADR 0006; MID-10 e MID-14) com as
// migrations reais (Postgres do compose ou PGlite), o S3 e as filas em memória, vídeos montados em
// código (`sampleMp4`) e um dublê do cliente do MediaConvert: nada sai da máquina. A remoção da
// localização pelo MediaConvert de verdade só é verificável na AWS (A-21; roteiro do MID-14 em
// docs/equipe/testes.md §8.2).
import { type CreateJobCommand } from '@aws-sdk/client-mediaconvert';
import { eq, postMedia, posts, users } from '@sussurro/db';
import {
  createPost,
  createTestDatabase,
  createUser,
  type TestDatabase,
} from '@sussurro/db/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { jpegWithEverything, metadataTraces } from './fixtures/media.js';
import { purgeDeletedPosts, purgeStaleDrafts, runCleanup } from '../src/jobs/cleanup.js';
import { purgeDeletedAccounts } from '../src/jobs/maintenance.js';
import { MediaJobHandler } from '../src/media/media-job.handler.js';
import { MediaJobsConsumer } from '../src/media/media-jobs.consumer.js';
import {
  type MediaConvertSender,
  MediaConvertVideoProcessor,
} from '../src/media/mediaconvert-video-processor.js';
import { sampleMp4 } from '../src/media/mp4-sample.js';
import { PassthroughVideoProcessor } from '../src/media/passthrough-video-processor.js';
import { VideoEventsConsumer } from '../src/media/video-events.consumer.js';
import { VideoEventsHandler } from '../src/media/video-events.handler.js';
import { type VideoProcessor, videoOutputKeys } from '../src/media/video-processor.js';
import { FakeClock } from '../src/testing/fake-clock.js';
import { InMemoryQueue } from '../src/testing/in-memory-queue.js';
import { InMemoryObjectStorage } from '../src/testing/in-memory-storage.js';

let testDb: TestDatabase;
const storage = new InMemoryObjectStorage();
const clock = new FakeClock();
const LIMITS = { maxPixels: 40_000_000 };
const BUCKET = 'sussurro-media-teste';
const ROLE = 'arn:aws:iam::123456789012:role/sussurro-mediaconvert';
const attempt = { attempt: 1, maxAttempts: 3 };

let posterWithGps: Buffer;

beforeAll(async () => {
  testDb = await createTestDatabase();
  posterWithGps = await jpegWithEverything();
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.truncate();
  storage.clear();
  clock.set(new Date('2026-10-30T12:00:00.000Z'));
});

/** Dublê do cliente do MediaConvert: guarda os comandos e devolve um id de job por chamada. */
function fakeMediaConvert() {
  const sent: CreateJobCommand[] = [];
  const client: MediaConvertSender = {
    send: (command) => {
      sent.push(command);
      return Promise.resolve({ Job: { Id: `job-${String(sent.length)}` }, $metadata: {} } as never);
    },
  };
  return { sent, client };
}

function passthrough(): VideoProcessor {
  return new PassthroughVideoProcessor(storage, LIMITS);
}

function mediaConvert(client: MediaConvertSender): VideoProcessor {
  return new MediaConvertVideoProcessor(client, storage, {
    bucket: BUCKET,
    roleArn: ROLE,
    queueArn: undefined,
  });
}

function handler(video: VideoProcessor) {
  return new MediaJobHandler(testDb.db, storage, clock, LIMITS, video);
}

/** Reel em `processing` (depois do `publish`), com o vídeo e o poster já em `incoming/`. */
async function processingReel(
  options: { video?: Buffer | null; poster?: Buffer | null; posterMime?: string } = {},
) {
  const author = await createUser(testDb.db);
  const post = await createPost(testDb.db, author, { type: 'reel', status: 'processing' });
  const media = post.media[0]!;
  await testDb.db
    .update(postMedia)
    .set({ posterMime: options.posterMime ?? 'image/jpeg' })
    .where(eq(postMedia.id, media.id));
  const video = options.video === undefined ? sampleMp4({ durationS: 42.5 }) : options.video;
  if (video !== null) {
    storage.objects.set(media.incomingKey, { body: video, contentType: 'video/mp4' });
  }
  const poster = options.poster === undefined ? posterWithGps : options.poster;
  if (poster !== null) {
    storage.objects.set(media.posterIncomingKey!, { body: poster, contentType: 'image/jpeg' });
  }
  return { author, post, media };
}

async function mediaRow(id: string) {
  const [row] = await testDb.db.select().from(postMedia).where(eq(postMedia.id, id));
  return row!;
}

async function postRow(id: string) {
  const [row] = await testDb.db.select().from(posts).where(eq(posts.id, id));
  return row!;
}

function videoMessage(mediaId: string) {
  return { type: 'post-video' as const, mediaId };
}

describe('passthrough (VIDEO_PROCESSOR=passthrough, história 5.1)', () => {
  it('[5.1 CA1] o reel vira ready com o poster do app e o post é publicado; incoming/ é apagado', async () => {
    const { post, media } = await processingReel();
    await expect(handler(passthrough()).handle(videoMessage(media.id), attempt)).resolves.toBe(
      'done',
    );

    const keys = videoOutputKeys(media.id);
    expect(await mediaRow(media.id)).toMatchObject({
      status: 'ready',
      storageKey: keys.video,
      thumbKey: keys.poster,
      width: 720,
      height: 1280,
      durationS: 42.5,
      error: null,
    });
    expect(await postRow(post.id)).toMatchObject({
      status: 'published',
      publishedAt: clock.now(),
    });
    expect(storage.objects.get(keys.video)?.contentType).toBe('video/mp4');
    expect(storage.objects.has(media.incomingKey)).toBe(false);
    expect(storage.objects.has(media.posterIncomingKey!)).toBe(false);
  });

  it('[MID-05] [MID-14] o poster do app sai sem EXIF, GPS, XMP, IPTC nem ICC, com 720 px', async () => {
    const { media } = await processingReel();
    expect(metadataTraces(posterWithGps).length).toBeGreaterThan(0);
    await handler(passthrough()).handle(videoMessage(media.id), attempt);

    const output = storage.objects.get(videoOutputKeys(media.id).poster);
    expect(output?.contentType).toBe('image/jpeg');
    const metadata = await sharp(output!.body).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg' });
    expect(metadata.width).toBeLessThanOrEqual(720);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadataTraces(output!.body)).toEqual([]);
  });

  it('[MID-14] .mov do iPhone com o moov no fim: aceito, servido como video/quicktime, sem ler o vídeo inteiro', async () => {
    const video = sampleMp4({
      durationS: 30,
      brand: 'qt  ',
      moovAtEnd: true,
      width: 1080,
      height: 1920,
      mdatBytes: 3_000_000,
    });
    const { media } = await processingReel({ video });
    await handler(passthrough()).handle(videoMessage(media.id), attempt);
    expect(await mediaRow(media.id)).toMatchObject({ status: 'ready', width: 1080, height: 1920 });
    expect(storage.objects.get(videoOutputKeys(media.id).video)?.contentType).toBe(
      'video/quicktime',
    );
    const read = storage.rangeReads.reduce((sum, item) => sum + item.length, 0);
    expect(read).toBeLessThan(10_000);
  });

  it('[MID-14] 90 s → ready; 91 s medidos no arquivo → failed, e nada fica em media/ nem em incoming/', async () => {
    const ok = await processingReel({ video: sampleMp4({ durationS: 90 }) });
    await handler(passthrough()).handle(videoMessage(ok.media.id), attempt);
    expect((await mediaRow(ok.media.id)).status).toBe('ready');

    const long = await processingReel({ video: sampleMp4({ durationS: 91 }) });
    await expect(handler(passthrough()).handle(videoMessage(long.media.id), attempt)).resolves.toBe(
      'done',
    );
    const row = await mediaRow(long.media.id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/91\.00 s; o limite é 90 s/);
    expect((await postRow(long.post.id)).status).toBe('failed');
    expect(storage.objects.has(videoOutputKeys(long.media.id).video)).toBe(false);
    expect(storage.objects.has(long.media.incomingKey)).toBe(false);
    expect(storage.objects.has(long.media.posterIncomingKey!)).toBe(false);
  });

  it.each([
    ['HTML disfarçado de MP4', { video: Buffer.from('<!doctype html><p>oi</p>') }],
    ['vídeo ausente em incoming/', { video: null }],
    ['poster ausente em incoming/', { poster: null }],
    ['poster que não é imagem', { poster: Buffer.from('<svg></svg>') }],
  ])('[MID-10] %s → failed na hora (sem 3 tentativas)', async (_name, options) => {
    const { post, media } = await processingReel(options);
    await expect(handler(passthrough()).handle(videoMessage(media.id), attempt)).resolves.toBe(
      'done',
    );
    expect((await mediaRow(media.id)).status).toBe('failed');
    expect((await postRow(post.id)).status).toBe('failed');
  });

  it('mensagem repetida depois de pronto não muda nada (idempotente)', async () => {
    const { media } = await processingReel();
    await handler(passthrough()).handle(videoMessage(media.id), attempt);
    const before = await mediaRow(media.id);
    const deleted = storage.deletedKeys.length;
    clock.advance(60_000);
    await expect(handler(passthrough()).handle(videoMessage(media.id), attempt)).resolves.toBe(
      'done',
    );
    expect(await mediaRow(media.id)).toEqual(before);
    expect(storage.deletedKeys).toHaveLength(deleted);
  });

  it('[MID-10] S3 fora nas 3 entregas → failed na 3ª e a mensagem vai para a DLQ', async () => {
    const { post, media } = await processingReel();
    const queue = new InMemoryQueue({ visibilityTimeoutMs: 1_000, maxReceiveCount: 3 });
    const consumer = new MediaJobsConsumer(queue, handler(passthrough()), {
      concurrency: 1,
      waitTimeSeconds: 0,
      maxAttempts: 3,
    });
    queue.send(videoMessage(media.id));
    for (let delivery = 1; delivery <= 3; delivery++) {
      storage.failGets = 1;
      expect(await consumer.pollOnce()).toBe(1);
      expect((await mediaRow(media.id)).status).toBe(delivery < 3 ? 'processing' : 'failed');
      queue.advance(1_001);
    }
    expect((await postRow(post.id)).status).toBe('failed');
    expect(await consumer.pollOnce()).toBe(0);
    expect(queue.deadLetters).toHaveLength(1);
  });

  it('[5.2 CA4] [A-21] o passthrough copia o vídeo com os metadados: em dev, só vídeos sem localização', async () => {
    const location = '+37.3349-122.0090/';
    const { media } = await processingReel({ video: sampleMp4({ durationS: 10, location }) });
    await handler(passthrough()).handle(videoMessage(media.id), attempt);
    const copied = storage.objects.get(videoOutputKeys(media.id).video)!.body;
    // É por isso que o worker recusa VIDEO_PROCESSOR=passthrough em produção (env.schema.ts).
    expect(copied.includes(Buffer.from(location, 'latin1'))).toBe(true);
  });
});

describe('MediaConvert (VIDEO_PROCESSOR=mediaconvert, história 5.2) com o cliente da AWS falso', () => {
  function events(video: VideoProcessor) {
    return new VideoEventsHandler(testDb.db, storage, clock, video);
  }

  function completeEvent(
    mediaId: string,
    jobId: string,
    options: { durationInMs?: number; app?: string } = {},
  ) {
    return {
      'detail-type': 'MediaConvert Job State Change',
      source: 'aws.mediaconvert',
      detail: {
        jobId,
        status: 'COMPLETE',
        userMetadata: { app: options.app ?? 'sussurro', mediaId },
        outputGroupDetails: [
          {
            outputDetails: [
              {
                outputFilePaths: [`s3://${BUCKET}/media/${mediaId}/video.mp4`],
                durationInMs: options.durationInMs ?? 42_480,
                videoDetails: { widthInPx: 720, heightInPx: 1280 },
              },
            ],
          },
          {
            outputDetails: [
              { outputFilePaths: [`s3://${BUCKET}/media/${mediaId}/poster.0000000.jpg`] },
            ],
          },
        ],
      },
    };
  }

  function errorEvent(mediaId: string, jobId: string) {
    return {
      'detail-type': 'MediaConvert Job State Change',
      source: 'aws.mediaconvert',
      detail: {
        jobId,
        status: 'ERROR',
        errorCode: 1040,
        errorMessage: 'Input file is not a supported format',
        userMetadata: { app: 'sussurro', mediaId },
      },
    };
  }

  /** Simula as saídas que o MediaConvert grava antes do evento COMPLETE. */
  function writeOutputs(mediaId: string) {
    const keys = videoOutputKeys(mediaId);
    storage.objects.set(keys.video, { body: Buffer.from('mp4'), contentType: 'video/mp4' });
    storage.objects.set(keys.mediaConvertPoster, { body: Buffer.from('jpg'), contentType: 'x' });
  }

  async function submitted() {
    const { client, sent } = fakeMediaConvert();
    const video = mediaConvert(client);
    const reel = await processingReel();
    await expect(handler(video).handle(videoMessage(reel.media.id), attempt)).resolves.toBe('done');
    return { ...reel, video, sent };
  }

  it('[5.2] cria um job (userMetadata.app) e o post continua processing até o evento', async () => {
    const { post, media, sent } = await submitted();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toMatchObject({
      Role: ROLE,
      ClientRequestToken: media.id,
      UserMetadata: { app: 'sussurro', mediaId: media.id },
    });
    expect(await mediaRow(media.id)).toMatchObject({
      status: 'processing',
      processorJobId: 'job-1',
    });
    expect((await postRow(post.id)).status).toBe('processing');
    // O MediaConvert gera o próprio poster: o do app sai de incoming/ na hora; o vídeo fica para o job.
    expect(storage.objects.has(media.posterIncomingKey!)).toBe(false);
    expect(storage.objects.has(media.incomingKey)).toBe(true);
  });

  it('mensagem repetida depois do job criado não cria outro', async () => {
    const { media, video, sent } = await submitted();
    await expect(handler(video).handle(videoMessage(media.id), attempt)).resolves.toBe('done');
    expect(sent).toHaveLength(1);
  });

  it('[MID-14] vídeo de 91 s ou que não é vídeo: failed sem criar job (não paga a conversão)', async () => {
    const { client, sent } = fakeMediaConvert();
    const long = await processingReel({ video: sampleMp4({ durationS: 91 }) });
    await handler(mediaConvert(client)).handle(videoMessage(long.media.id), attempt);
    expect((await mediaRow(long.media.id)).status).toBe('failed');
    expect(sent).toHaveLength(0);
  });

  it('[5.2 CA2] COMPLETE → published, com as saídas do evento; o original sai de incoming/', async () => {
    const { post, media, video } = await submitted();
    writeOutputs(media.id);
    clock.advance(90_000);
    await expect(events(video).handle(completeEvent(media.id, 'job-1'))).resolves.toBe('done');
    expect(await mediaRow(media.id)).toMatchObject({
      status: 'ready',
      storageKey: `media/${media.id}/video.mp4`,
      thumbKey: `media/${media.id}/poster.0000000.jpg`,
      width: 720,
      height: 1280,
      durationS: 42.48,
    });
    expect(await postRow(post.id)).toMatchObject({
      status: 'published',
      publishedAt: clock.now(),
    });
    expect(storage.objects.has(media.incomingKey)).toBe(false);
  });

  it('[5.2 CA2] COMPLETE repetido é idempotente (nada muda, nada é apagado)', async () => {
    const { media, video } = await submitted();
    writeOutputs(media.id);
    await events(video).handle(completeEvent(media.id, 'job-1'));
    const before = await mediaRow(media.id);
    const deleted = [...storage.deletedKeys];
    clock.advance(60_000);
    await expect(events(video).handle(completeEvent(media.id, 'job-1'))).resolves.toBe('done');
    expect(await mediaRow(media.id)).toEqual(before);
    expect(storage.deletedKeys).toEqual(deleted);
    expect(storage.objects.has(`media/${media.id}/video.mp4`)).toBe(true);
  });

  it('[5.2 CA2] [MID-10] ERROR → failed (só o autor vê); repetido não muda nada', async () => {
    const { post, media, video } = await submitted();
    await events(video).handle(errorEvent(media.id, 'job-1'));
    const row = await mediaRow(media.id);
    expect(row).toMatchObject({ status: 'failed' });
    expect(row.error).toContain('MediaConvert 1040');
    expect((await postRow(post.id)).status).toBe('failed');
    expect(storage.objects.has(media.incomingKey)).toBe(false);
    await events(video).handle(errorEvent(media.id, 'job-1'));
    expect(await mediaRow(media.id)).toEqual(row);
  });

  it('[5.2 CA3] evento de outro app ou de job desconhecido é descartado sem efeito', async () => {
    const { post, media, video } = await submitted();
    writeOutputs(media.id);
    const before = { media: await mediaRow(media.id), post: await postRow(post.id) };
    const deleted = storage.deletedKeys.length;
    const discarded = [
      completeEvent(media.id, 'job-1', { app: 'outro-app' }),
      completeEvent(media.id, 'job-que-nao-existe'),
      errorEvent(media.id, 'job-de-outro-ambiente'),
      completeEvent('01a189e0-af57-7000-85fe-2054e618fea6', 'job-1'),
      { source: 'aws.mediaconvert', detail: { status: 'COMPLETE' } },
    ];
    for (const event of discarded) {
      await expect(events(video).handle(event)).resolves.toBe('done');
    }
    expect(await mediaRow(media.id)).toEqual(before.media);
    expect(await postRow(post.id)).toEqual(before.post);
    expect(storage.deletedKeys).toHaveLength(deleted);
    expect(storage.objects.has(media.incomingKey)).toBe(true);
  });

  it('[MID-14] COMPLETE com duração acima de 90 s → failed e as saídas são apagadas', async () => {
    const { post, media, video } = await submitted();
    writeOutputs(media.id);
    await events(video).handle(completeEvent(media.id, 'job-1', { durationInMs: 95_000 }));
    expect((await mediaRow(media.id)).status).toBe('failed');
    expect((await postRow(post.id)).status).toBe('failed');
    expect(storage.objects.has(`media/${media.id}/video.mp4`)).toBe(false);
    expect(storage.objects.has(`media/${media.id}/poster.0000000.jpg`)).toBe(false);
  });

  it('COMPLETE depois do tempo esgotado: continua failed e as saídas atrasadas são apagadas', async () => {
    const { post, media, video } = await submitted();
    clock.advance(61 * 60_000);
    await runCleanup(testDb.db, storage, {
      now: clock.now(),
      draftTtlHours: 24,
      processingTimeoutMin: 60,
    });
    expect((await postRow(post.id)).status).toBe('failed');
    writeOutputs(media.id);
    await events(video).handle(completeEvent(media.id, 'job-1'));
    expect((await mediaRow(media.id)).status).toBe('failed');
    expect(storage.objects.has(`media/${media.id}/video.mp4`)).toBe(false);
  });

  it('consumidor da video-events: apaga o evento descartado, processa o COMPLETE e manda o que não é JSON para a DLQ', async () => {
    const { post, media, video } = await submitted();
    writeOutputs(media.id);
    const queue = new InMemoryQueue({ visibilityTimeoutMs: 1_000, maxReceiveCount: 3 });
    const consumer = new VideoEventsConsumer(queue, events(video), {
      concurrency: 5,
      waitTimeSeconds: 0,
      maxAttempts: 3,
    });
    queue.send(completeEvent(media.id, 'job-1', { app: 'outro-app' }));
    queue.send(completeEvent(media.id, 'job-1'));
    queue.send('isto não é json');
    expect(await consumer.pollOnce()).toBe(3);
    expect((await postRow(post.id)).status).toBe('published');
    for (let delivery = 2; delivery <= 4; delivery++) {
      queue.advance(1_001);
      await consumer.pollOnce();
    }
    expect(queue.pending).toBe(0);
    expect(queue.deadLetters.map((letter) => letter.body)).toEqual(['isto não é json']);
  });
});

describe('limpeza dos reels (2.9, 2.11, CONTA-05)', () => {
  it('[MID-11] reel apagado: saem o vídeo, o poster e o que restou em incoming/', async () => {
    const author = await createUser(testDb.db);
    const reel = await createPost(testDb.db, author, { type: 'reel', deletedAt: new Date() });
    const media = reel.media[0]!;
    const keys = [media.storageKey!, media.thumbKey!, media.incomingKey, media.posterIncomingKey!];
    for (const key of keys) {
      storage.objects.set(key, { body: Buffer.from('x'), contentType: 'x' });
    }
    await expect(purgeDeletedPosts(testDb.db, storage)).resolves.toMatchObject({ posts: 1 });
    for (const key of keys) {
      expect(storage.objects.has(key)).toBe(false);
    }
    expect(storage.deletedKeys).toEqual(
      expect.arrayContaining([...keys, videoOutputKeys(media.id).mediaConvertPoster]),
    );
  });

  it('reel apagado com o job do MediaConvert rodando espera o evento (as saídas não ficam órfãs)', async () => {
    const author = await createUser(testDb.db);
    const reel = await createPost(testDb.db, author, {
      type: 'reel',
      status: 'processing',
      deletedAt: new Date(),
    });
    await testDb.db
      .update(postMedia)
      .set({ processorJobId: 'job-9' })
      .where(eq(postMedia.id, reel.media[0]!.id));
    await expect(purgeDeletedPosts(testDb.db, storage)).resolves.toMatchObject({ posts: 0 });
    await testDb.db
      .update(postMedia)
      .set({ status: 'failed' })
      .where(eq(postMedia.id, reel.media[0]!.id));
    await expect(purgeDeletedPosts(testDb.db, storage)).resolves.toMatchObject({ posts: 1 });
  });

  it('[MID-12] rascunho de reel abandonado: o vídeo e o poster saem de incoming/', async () => {
    const author = await createUser(testDb.db);
    const draft = await createPost(testDb.db, author, {
      type: 'reel',
      status: 'draft',
      createdAt: new Date('2026-10-28T00:00:00.000Z'),
    });
    const media = draft.media[0]!;
    storage.objects.set(media.incomingKey, { body: Buffer.from('v'), contentType: 'x' });
    storage.objects.set(media.posterIncomingKey!, { body: Buffer.from('p'), contentType: 'x' });
    await purgeStaleDrafts(testDb.db, storage, new Date('2026-10-29T12:00:00.000Z'));
    expect(storage.objects.size).toBe(0);
  });

  it('[CONTA-05] hard delete da conta apaga também os objetos dos reels', async () => {
    const author = await createUser(testDb.db, { deletedAt: new Date('2026-09-01T00:00:00Z') });
    const reel = await createPost(testDb.db, author, { type: 'reel' });
    const media = reel.media[0]!;
    for (const key of [media.storageKey!, media.thumbKey!, media.posterIncomingKey!]) {
      storage.objects.set(key, { body: Buffer.from('x'), contentType: 'x' });
    }
    await purgeDeletedAccounts(testDb.db, storage, new Date('2026-10-01T00:00:00Z'));
    expect(storage.objects.size).toBe(0);
    expect(await testDb.db.select().from(users)).toHaveLength(0);
  });
});
