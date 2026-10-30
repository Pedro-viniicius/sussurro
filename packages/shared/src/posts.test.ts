import { describe, expect, it } from 'vitest';

import { FeedQuerySchema, feedWindowLabel } from './feed.ts';
import { MediaJobMessageSchema, SetAvatarRequestSchema } from './media.ts';
import {
  CaptionSchema,
  CommentBodySchema,
  CreateCommentRequestSchema,
  CreateDraftRequestSchema,
  CreateTextPostRequestSchema,
  formatReelDuration,
  LikeStateSchema,
  MAX_IMAGE_BYTES,
  MAX_POSTER_BYTES,
  MAX_REEL_DURATION_S,
  MAX_VIDEO_BYTES,
  PostSchema,
  PublishPostRequestSchema,
  reelVideoLimitViolation,
} from './posts.ts';

const jpeg = { mime: 'image/jpeg', sizeBytes: 1024 } as const;

describe('CreateTextPostRequestSchema (2.1)', () => {
  it('[TXT-01] normaliza (NFC, \\r\\n) e tira os espaços das pontas ao gravar', () => {
    expect(CreateTextPostRequestSchema.parse({ type: 'text', text: '  café\r\nbom ' })).toEqual({
      type: 'text',
      text: 'café\nbom',
    });
  });

  it('campo a mais → recusa (strict)', () => {
    expect(
      CreateTextPostRequestSchema.safeParse({ type: 'text', text: 'oi', status: 'draft' }).success,
    ).toBe(false);
  });
});

describe('CreateDraftRequestSchema (MID-01 a MID-03)', () => {
  it('[MID-01] 1 e 4 imagens passam; 0 e 5 não', () => {
    const items = (n: number) => Array.from({ length: n }, () => jpeg);
    expect(CreateDraftRequestSchema.safeParse({ type: 'photo', items: items(1) }).success).toBe(
      true,
    );
    expect(CreateDraftRequestSchema.safeParse({ type: 'photo', items: items(4) }).success).toBe(
      true,
    );
    expect(CreateDraftRequestSchema.safeParse({ type: 'photo', items: items(0) }).success).toBe(
      false,
    );
    expect(CreateDraftRequestSchema.safeParse({ type: 'photo', items: items(5) }).success).toBe(
      false,
    );
  });

  it.each([['image/jpeg'], ['image/png'], ['image/webp']])('[MID-02] %s é aceito', (mime) => {
    expect(
      CreateDraftRequestSchema.safeParse({ type: 'photo', items: [{ mime, sizeBytes: 10 }] })
        .success,
    ).toBe(true);
  });

  it.each([['image/heic'], ['image/gif'], ['application/pdf'], ['video/mp4'], ['image/svg+xml']])(
    '[MID-02] %s → recusado',
    (mime) => {
      expect(
        CreateDraftRequestSchema.safeParse({ type: 'photo', items: [{ mime, sizeBytes: 10 }] })
          .success,
      ).toBe(false);
    },
  );

  it('[MID-03] 15 MB exatos passam; 15 MB + 1 byte e 0 byte não', () => {
    const parse = (sizeBytes: number) =>
      CreateDraftRequestSchema.safeParse({
        type: 'photo',
        items: [{ mime: 'image/jpeg', sizeBytes }],
      }).success;
    expect(MAX_IMAGE_BYTES).toBe(15_728_640);
    expect(parse(MAX_IMAGE_BYTES)).toBe(true);
    expect(parse(MAX_IMAGE_BYTES + 1)).toBe(false);
    expect(parse(0)).toBe(false);
    expect(parse(1.5)).toBe(false);
  });

  it('reel no formato de foto (items) → recusado', () => {
    expect(CreateDraftRequestSchema.safeParse({ type: 'reel', items: [jpeg] }).success).toBe(false);
  });
});

describe('rascunho de reel (5.3, D10, MID-14)', () => {
  const video = { mime: 'video/mp4', sizeBytes: 50_000_000, durationS: 42.5 } as const;
  const poster = { mime: 'image/jpeg', sizeBytes: 120_000 } as const;
  const parse = (overrides: Record<string, unknown> = {}) =>
    CreateDraftRequestSchema.safeParse({ type: 'reel', video, poster, ...overrides });

  it('[MID-14] 90 s e 200 MB exatos passam; .mov do iPhone (video/quicktime) também', () => {
    expect(MAX_REEL_DURATION_S).toBe(90);
    expect(MAX_VIDEO_BYTES).toBe(209_715_200);
    expect(parse({ video: { ...video, durationS: 90, sizeBytes: MAX_VIDEO_BYTES } }).success).toBe(
      true,
    );
    expect(parse({ video: { ...video, mime: 'video/quicktime' } }).success).toBe(true);
  });

  it('[MID-14] 91 s, 90,01 s ou 200 MB + 1 byte → recusado', () => {
    expect(parse({ video: { ...video, durationS: 91 } }).success).toBe(false);
    expect(parse({ video: { ...video, durationS: 90.01 } }).success).toBe(false);
    expect(parse({ video: { ...video, sizeBytes: MAX_VIDEO_BYTES + 1 } }).success).toBe(false);
  });

  it('duração zero, negativa, infinita ou ausente → recusada; guarda 2 casas para cima', () => {
    for (const durationS of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, '30']) {
      expect(parse({ video: { ...video, durationS } }).success).toBe(false);
    }
    expect(parse({ video: { mime: 'video/mp4', sizeBytes: 10 } }).success).toBe(false);
    const parsed = CreateDraftRequestSchema.parse({
      type: 'reel',
      video: { ...video, durationS: 0.001 },
      poster,
    });
    expect(parsed.type === 'reel' && parsed.video.durationS).toBe(0.01);
  });

  it.each([['video/webm'], ['video/x-matroska'], ['image/jpeg'], ['application/octet-stream']])(
    '[MID-14] vídeo %s → recusado',
    (mime) => {
      expect(parse({ video: { ...video, mime } }).success).toBe(false);
    },
  );

  it('poster obrigatório: imagem de até 5 MB; vídeo como poster → recusado', () => {
    expect(MAX_POSTER_BYTES).toBe(5 * 1024 * 1024);
    expect(parse({ poster: undefined }).success).toBe(false);
    expect(parse({ poster: { ...poster, sizeBytes: MAX_POSTER_BYTES } }).success).toBe(true);
    expect(parse({ poster: { ...poster, sizeBytes: MAX_POSTER_BYTES + 1 } }).success).toBe(false);
    expect(parse({ poster: { ...poster, mime: 'video/mp4' } }).success).toBe(false);
    expect(parse({ poster: { ...poster, mime: 'image/png' } }).success).toBe(true);
  });

  it('campo a mais no reel, no vídeo ou no poster → recusado (strict)', () => {
    expect(parse({ items: [jpeg] }).success).toBe(false);
    expect(parse({ video: { ...video, width: 1080 } }).success).toBe(false);
    expect(parse({ poster: { ...poster, url: 'x' } }).success).toBe(false);
  });

  it('reelVideoLimitViolation: a mesma regra no app (grade do Criar) e na API', () => {
    expect(reelVideoLimitViolation({ durationS: 90, sizeBytes: MAX_VIDEO_BYTES })).toBeNull();
    expect(reelVideoLimitViolation({ durationS: 90.5, sizeBytes: 1 })).toBe('too_long');
    expect(reelVideoLimitViolation({ durationS: 0, sizeBytes: 1 })).toBe('too_long');
    expect(reelVideoLimitViolation({ durationS: 10, sizeBytes: MAX_VIDEO_BYTES + 1 })).toBe(
      'too_large',
    );
    expect(reelVideoLimitViolation({ durationS: 10, sizeBytes: 0 })).toBe('too_large');
  });

  it('formatReelDuration: 0:42, 1:30, 0:05; arredonda e trata inválidos', () => {
    expect(formatReelDuration(42)).toBe('0:42');
    expect(formatReelDuration(90)).toBe('1:30');
    expect(formatReelDuration(5.4)).toBe('0:05');
    expect(formatReelDuration(59.6)).toBe('1:00');
    expect(formatReelDuration(Number.NaN)).toBe('0:00');
    expect(formatReelDuration(-3)).toBe('0:00');
  });
});

describe('CaptionSchema e CommentBodySchema (TXT-04)', () => {
  it('[TXT-04] legenda até 2200; 2201 → recusa; vazia ou só espaços vira null', () => {
    expect(CaptionSchema.parse('a'.repeat(2200))).toHaveLength(2200);
    expect(CaptionSchema.safeParse('a'.repeat(2201)).success).toBe(false);
    expect(CaptionSchema.parse('   ')).toBeNull();
    expect(CaptionSchema.parse(undefined)).toBeNull();
    expect(CaptionSchema.parse(null)).toBeNull();
    expect(PublishPostRequestSchema.parse({})).toEqual({ caption: null });
  });

  it('[TXT-04] comentário de 1 a 500; vazio, só invisíveis ou 501 → recusa', () => {
    expect(CommentBodySchema.parse('😀'.repeat(500))).toHaveLength(1000);
    expect(CommentBodySchema.safeParse('a'.repeat(501)).success).toBe(false);
    expect(CommentBodySchema.safeParse('').success).toBe(false);
    expect(CommentBodySchema.safeParse('​').success).toBe(false);
  });

  it('parentId precisa ser um uuid', () => {
    expect(CreateCommentRequestSchema.safeParse({ body: 'oi', parentId: 'x' }).success).toBe(false);
  });
});

describe('contratos de resposta', () => {
  it('[PERM-15] post e estado da curtida: só contador e likedByMe, nenhuma lista', () => {
    expect(Object.keys(LikeStateSchema.shape).sort()).toEqual(['likeCount', 'likedByMe']);
    expect(Object.keys(PostSchema.shape).sort()).toEqual([
      'author',
      'caption',
      'commentCount',
      'createdAt',
      'id',
      'isOwn',
      'likeCount',
      'likedByMe',
      'media',
      'publishedAt',
      'status',
      'text',
      'type',
    ]);
    expect(Object.keys(PostSchema.shape.author.shape).sort()).toEqual([
      'accountType',
      'avatarUrl',
      'handle',
      'name',
    ]);
  });

  it('mensagem da fila media-jobs só leva ids', () => {
    expect(
      MediaJobMessageSchema.parse({
        type: 'post-media',
        mediaId: '01a189e0-af57-7000-85fe-2054e618fea6',
      }),
    ).toEqual({ type: 'post-media', mediaId: '01a189e0-af57-7000-85fe-2054e618fea6' });
    expect(
      MediaJobMessageSchema.parse({
        type: 'post-video',
        mediaId: '01a189e0-af57-7000-85fe-2054e618fea6',
      }),
    ).toEqual({ type: 'post-video', mediaId: '01a189e0-af57-7000-85fe-2054e618fea6' });
    expect(MediaJobMessageSchema.safeParse({ type: 'video', mediaId: 'x' }).success).toBe(false);
    expect(MediaJobMessageSchema.safeParse({ type: 'post-video', mediaId: 'x' }).success).toBe(
      false,
    );
    expect(SetAvatarRequestSchema.safeParse({ uploadId: 'abc' }).success).toBe(false);
  });
});

describe('FeedQuerySchema (FEED-05, FEED-09)', () => {
  it('[FEED-05] type obrigatório e só photo|text|reel', () => {
    expect(FeedQuerySchema.safeParse({}).success).toBe(false);
    expect(FeedQuerySchema.safeParse({ type: 'video' }).success).toBe(false);
    expect(FeedQuerySchema.parse({ type: 'text' })).toEqual({ type: 'text', limit: 20 });
  });

  it('[FEED-09] limit acima de 50 vira 50; 0, negativo ou texto → recusa', () => {
    expect(FeedQuerySchema.parse({ type: 'photo', limit: '80' }).limit).toBe(50);
    expect(FeedQuerySchema.parse({ type: 'photo', limit: '7' }).limit).toBe(7);
    for (const limit of ['0', '-1', 'abc', '2.5']) {
      expect(FeedQuerySchema.safeParse({ type: 'photo', limit }).success).toBe(false);
    }
  });

  it('[FEED-04] texto do "Você está em dia" a partir de windowHours', () => {
    expect(feedWindowLabel(72)).toBe('últimos 3 dias');
    expect(feedWindowLabel(24)).toBe('último dia');
    expect(feedWindowLabel(36)).toBe('últimas 36 horas');
    expect(feedWindowLabel(1)).toBe('última hora');
  });
});
