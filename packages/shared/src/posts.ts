import { z } from 'zod';

import {
  CAPTION_MAX_LENGTH,
  COMMENT_MAX_LENGTH,
  countChars,
  isBlankText,
  normalizeText,
  POST_TEXT_MAX_LENGTH,
} from './text.ts';
import { AccountTypeSchema } from './users.ts';

// --- enums (arquitetura.md §6) -----------------------------------------------------------------

/** Abas do feed e do perfil: fotos, textos e reels (desde a Fase 5). */
export const PostTypeSchema = z.enum(['photo', 'text', 'reel']);
export type PostType = z.infer<typeof PostTypeSchema>;

/**
 * Ciclo do post: texto nasce `published`; foto e reel nascem `draft`, viram `processing` no
 * `publish` e `published` (ou `failed`) quando o worker termina (ADR 0009 e ADR 0006).
 */
export const PostStatusSchema = z.enum(['draft', 'processing', 'published', 'failed']);
export type PostStatus = z.infer<typeof PostStatusSchema>;

export const MediaStatusSchema = z.enum(['pending_upload', 'processing', 'ready', 'failed']);
export type MediaStatus = z.infer<typeof MediaStatusSchema>;

/** Imagem (foto de post) ou vídeo (reel, sempre na posição 0). */
export const MediaKindSchema = z.enum(['image', 'video']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

// --- limites de mídia (arquitetura.md §9, MID-01 a MID-03) --------------------------------------

/** Tipos aceitos nas fotos e no avatar. HEIC é convertido para JPEG no app. */
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ImageMimeSchema = z.enum(IMAGE_MIME_TYPES, {
  error: 'Use JPEG, PNG ou WebP.',
});
export type ImageMime = z.infer<typeof ImageMimeSchema>;

export const MAX_PHOTOS_PER_POST = 4;
/** 15 MB por imagem (MID-03): 15 × 1024 × 1024 bytes. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// --- limites do reel (D10, MID-14) ---------------------------------------------------------------

/**
 * Vídeo do reel: MP4 (Android e a maioria dos apps) ou QuickTime (`.mov` do iPhone, inclusive
 * HEVC). O worker confere o container pelos bytes (ISO BMFF) e não confia no tipo declarado.
 */
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const;
export const VideoMimeSchema = z.enum(VIDEO_MIME_TYPES, {
  error: 'Use um vídeo MP4 ou MOV.',
});
export type VideoMime = z.infer<typeof VideoMimeSchema>;

/** Tipos que uma URL de upload pode assinar: imagens (fotos, poster, avatar) e vídeo (reel). */
export const MEDIA_MIME_TYPES = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES] as const;
export const MediaMimeSchema = z.enum(MEDIA_MIME_TYPES);
export type MediaMime = z.infer<typeof MediaMimeSchema>;

/** D10: até 90 s por reel. 91 s → 400 no rascunho; o worker confere a duração real. */
export const MAX_REEL_DURATION_S = 90;
/** D10: até 200 MB por vídeo (200 × 1024 × 1024 bytes). 200 MB + 1 byte → 400. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/**
 * Poster (capa da grade e do visualizador), gerado no app (`expo-video-thumbnails`) e enviado com o
 * vídeo: até 5 MB. O worker tira todos os metadados (o mesmo pipeline das fotos).
 */
export const MAX_POSTER_BYTES = 5 * 1024 * 1024;

/** Por que um vídeo não pode virar reel (a grade do Criar esmaece com "Até 90 s"). */
export type ReelVideoLimitViolation = 'too_long' | 'too_large';

/**
 * Confere os limites do D10 antes de criar o rascunho (a mesma regra da API): duração acima de
 * 90 s → `too_long`; acima de 200 MB → `too_large`; dentro dos limites → `null`.
 */
export function reelVideoLimitViolation(video: {
  durationS: number;
  sizeBytes: number;
}): ReelVideoLimitViolation | null {
  if (!(video.durationS > 0) || video.durationS > MAX_REEL_DURATION_S) {
    return 'too_long';
  }
  if (!(video.sizeBytes > 0) || video.sizeBytes > MAX_VIDEO_BYTES) {
    return 'too_large';
  }
  return null;
}

/**
 * Duração do reel como na grade (`ux.md` §4.5, ReelTile): `0:42`, `1:30`. Arredonda para o segundo
 * mais próximo; valores inválidos viram `0:00`.
 */
export function formatReelDuration(durationS: number): string {
  const total = Number.isFinite(durationS) && durationS > 0 ? Math.round(durationS) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

const uuid = z.uuid({ error: 'Identificador inválido.' });
const count = z.int().min(0);
const isoDate = z.iso.datetime();

// --- textos -------------------------------------------------------------------------------------

/** Teto bruto (unidades UTF-16) antes de normalizar: barra entradas absurdas sem custo de NFC. */
const RAW_TEXT_GUARD = 20_000;

/**
 * Texto limitado (TXT-01, TXT-04): normaliza (NFC, `\r\n` → `\n`), recusa vazio ou só invisíveis,
 * conta code points **antes** de tirar os espaços das pontas (o mesmo número do contador do app,
 * TXT-02) e grava sem esses espaços.
 */
function boundedText(max: number, emptyMessage: string) {
  return z
    .string()
    .max(RAW_TEXT_GUARD, { error: `Use no máximo ${max} caracteres.` })
    .transform(normalizeText)
    .refine((value) => !isBlankText(value), { error: emptyMessage })
    .refine((value) => countChars(value) <= max, { error: `Use no máximo ${max} caracteres.` })
    .transform((value) => value.trim());
}

/** Texto de post: 1 a 280 code points depois de NFC (A-09). */
export const PostTextSchema = boundedText(POST_TEXT_MAX_LENGTH, 'Escreva alguma coisa.');

/** Comentário e resposta: 1 a 500 (TXT-04). */
export const CommentBodySchema = boundedText(COMMENT_MAX_LENGTH, 'Escreva um comentário.');

/** Legenda de foto: até 2200 (TXT-04). Vazia, só espaços ou ausente vira `null`. */
export const CaptionSchema = z
  .union([
    z.null(),
    z
      .string()
      .max(RAW_TEXT_GUARD, { error: `Use no máximo ${CAPTION_MAX_LENGTH} caracteres.` })
      .transform(normalizeText)
      .refine((value) => countChars(value) <= CAPTION_MAX_LENGTH, {
        error: `Use no máximo ${CAPTION_MAX_LENGTH} caracteres.`,
      })
      .transform((value) => (isBlankText(value) ? null : value.trim())),
  ])
  .optional()
  .transform((value) => value ?? null);

// --- requests ------------------------------------------------------------------------------------

/** `POST /posts`: só texto (foto passa por rascunho). Publica na hora. */
export const CreateTextPostRequestSchema = z.strictObject({
  type: z.literal('text'),
  text: PostTextSchema,
});
export type CreateTextPostRequest = z.infer<typeof CreateTextPostRequestSchema>;
export type CreateTextPostInput = z.input<typeof CreateTextPostRequestSchema>;

/** Uma imagem que o app vai enviar: tipo e tamanho exatos do arquivo (MID-02, MID-03). */
export const MediaItemRequestSchema = z.strictObject({
  mime: ImageMimeSchema,
  sizeBytes: z
    .int({ error: 'Tamanho inválido.' })
    .min(1, { error: 'Arquivo vazio.' })
    .max(MAX_IMAGE_BYTES, { error: 'Cada imagem pode ter até 15 MB.' }),
});
export type MediaItemRequest = z.infer<typeof MediaItemRequestSchema>;

/**
 * Rascunho de foto (ADR 0009): 1 a 4 imagens. O tamanho declarado fica assinado na URL de upload
 * (o S3 recusa um corpo maior).
 */
export const CreatePhotoDraftRequestSchema = z.strictObject({
  type: z.literal('photo'),
  items: z
    .array(MediaItemRequestSchema)
    .min(1, { error: 'Escolha pelo menos uma foto.' })
    .max(MAX_PHOTOS_PER_POST, { error: `Até ${MAX_PHOTOS_PER_POST} fotos por publicação.` }),
});
export type CreatePhotoDraftRequest = z.infer<typeof CreatePhotoDraftRequestSchema>;

/**
 * O vídeo do reel (D10, MID-14): tipo, tamanho exato do arquivo e duração em segundos, como o
 * seletor do aparelho informa. Até 90 s (91 → 400) e 200 MB (200 MB + 1 byte → 400). A duração é
 * guardada com 2 casas (arredondada para cima) e conferida de novo pelo worker no vídeo enviado.
 */
export const ReelVideoRequestSchema = z.strictObject({
  mime: VideoMimeSchema,
  sizeBytes: z
    .int({ error: 'Tamanho inválido.' })
    .min(1, { error: 'Arquivo vazio.' })
    .max(MAX_VIDEO_BYTES, { error: 'O vídeo pode ter até 200 MB.' }),
  durationS: z
    .number({ error: 'Duração inválida.' })
    .positive({ error: 'Duração inválida.' })
    .max(MAX_REEL_DURATION_S, { error: `O reel pode ter até ${String(MAX_REEL_DURATION_S)} s.` })
    .transform((value) => Math.ceil(value * 100) / 100),
});
export type ReelVideoRequest = z.infer<typeof ReelVideoRequestSchema>;

/** O poster do reel (capa), gerado no app: JPEG, PNG ou WebP de até 5 MB. */
export const ReelPosterRequestSchema = z.strictObject({
  mime: ImageMimeSchema,
  sizeBytes: z
    .int({ error: 'Tamanho inválido.' })
    .min(1, { error: 'Arquivo vazio.' })
    .max(MAX_POSTER_BYTES, { error: 'A capa pode ter até 5 MB.' }),
});
export type ReelPosterRequest = z.infer<typeof ReelPosterRequestSchema>;

/** Rascunho de reel (Fase 5, história 5.3): um vídeo vertical curto e o poster dele. */
export const CreateReelDraftRequestSchema = z.strictObject({
  type: z.literal('reel'),
  video: ReelVideoRequestSchema,
  poster: ReelPosterRequestSchema,
});
export type CreateReelDraftRequest = z.infer<typeof CreateReelDraftRequestSchema>;

/**
 * `POST /posts/drafts` (ADR 0009): foto (1 a 4 imagens) ou reel (1 vídeo + poster). Outro tipo,
 * campo a mais ou fora dos limites → 400.
 */
export const CreateDraftRequestSchema = z.discriminatedUnion('type', [
  CreatePhotoDraftRequestSchema,
  CreateReelDraftRequestSchema,
]);
export type CreateDraftRequest = z.infer<typeof CreateDraftRequestSchema>;
export type CreateDraftInput = z.input<typeof CreateDraftRequestSchema>;

/** `POST /posts/:id/publish`: a legenda entra aqui (é opcional). */
export const PublishPostRequestSchema = z.strictObject({
  caption: CaptionSchema,
});
export type PublishPostRequest = z.infer<typeof PublishPostRequestSchema>;
export type PublishPostInput = z.input<typeof PublishPostRequestSchema>;

// --- respostas -----------------------------------------------------------------------------------

/**
 * Como enviar um arquivo direto ao S3 (URL PUT pré-assinada por 10 min). O app manda exatamente
 * estes cabeçalhos: `Content-Type` e `Content-Length` estão na assinatura, e um arquivo diferente
 * do declarado é recusado pelo S3 (MID-03).
 */
export const UploadTargetSchema = z.object({
  method: z.literal('PUT'),
  url: z.url(),
  headers: z.object({
    /** Imagem (fotos, poster e avatar) ou vídeo (reel). */
    'Content-Type': MediaMimeSchema,
    'Content-Length': z.string().regex(/^\d+$/),
  }),
  expiresAt: isoDate,
});
export type UploadTarget = z.infer<typeof UploadTargetSchema>;

export const DraftUploadSchema = UploadTargetSchema.extend({
  mediaId: uuid,
  /** 0 a 3, na ordem escolhida (a primeira é a capa). */
  position: z
    .int()
    .min(0)
    .max(MAX_PHOTOS_PER_POST - 1),
});
export type DraftUpload = z.infer<typeof DraftUploadSchema>;

/**
 * Resposta de `POST /posts/drafts` (201). Foto: uma URL por imagem em `uploads`. Reel: o vídeo em
 * `uploads` (posição 0) e a URL do poster em `poster` (só existe no reel). O app envia os dois
 * antes do `publish`.
 */
export const DraftSchema = z.object({
  postId: uuid,
  status: z.literal('draft'),
  uploads: z.array(DraftUploadSchema),
  poster: UploadTargetSchema.optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

/**
 * Autor de um post ou comentário. Rótulo do app: criador → "Criador"; pessoal que não é o leitor →
 * "Conexão" (só conexões veem posts de conta pessoal).
 */
export const PostAuthorSchema = z.object({
  handle: z.string(),
  name: z.string(),
  avatarUrl: z.url().nullable(),
  accountType: AccountTypeSchema,
});
export type PostAuthor = z.infer<typeof PostAuthorSchema>;

/**
 * Uma imagem ou o vídeo do post. As URLs são assinadas (6 h, A-19) e só existem com
 * `status = ready`; a chave de cache no app é o `id` (a URL muda a cada resposta).
 */
export const PostMediaSchema = z.object({
  id: uuid,
  /** `video` só no reel (posição 0). */
  kind: MediaKindSchema,
  position: z
    .int()
    .min(0)
    .max(MAX_PHOTOS_PER_POST - 1),
  status: MediaStatusSchema,
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  /** Duração do vídeo em segundos (só `video` e `ready`; a grade mostra `formatReelDuration`). */
  durationS: z.number().positive().nullable(),
  /** Imagem: 1080 px de largura, JPEG sem metadados. Vídeo: o MP4 do reel. */
  url: z.url().nullable(),
  /** Imagem: 360 px de largura (grade do perfil). Vídeo: o poster (grade e visualizador). */
  thumbUrl: z.url().nullable(),
});
export type PostMedia = z.infer<typeof PostMediaSchema>;

/**
 * Post visto por quem pode vê-lo (`GET /posts/:id`, feed, perfil). Nunca traz lista de quem curtiu:
 * só `likeCount` e `likedByMe` (PERM-15). `status` diferente de `published` só aparece para o dono
 * (MID-09).
 */
export const PostSchema = z.object({
  id: uuid,
  type: PostTypeSchema,
  status: PostStatusSchema,
  author: PostAuthorSchema,
  /** O leitor é o autor (mostra "Excluir" e os estados de publicação). */
  isOwn: z.boolean(),
  /** Só em `text`. */
  text: z.string().nullable(),
  /** Só em `photo`/`reel`. */
  caption: z.string().nullable(),
  /** Fotos (1 a 4) ou o vídeo do reel (1). */
  media: z.array(PostMediaSchema),
  likeCount: count,
  commentCount: count,
  likedByMe: z.boolean(),
  createdAt: isoDate,
  /** Ordem do feed e do perfil; `null` enquanto não publicado. */
  publishedAt: isoDate.nullable(),
});
export type Post = z.infer<typeof PostSchema>;

/** Resposta de `PUT` e `DELETE /posts/:id/like` (idempotentes, CNT-04). */
export const LikeStateSchema = z.object({
  likeCount: count,
  likedByMe: z.boolean(),
});
export type LikeState = z.infer<typeof LikeStateSchema>;

// --- paginação -----------------------------------------------------------------------------------

/** Página padrão e máxima das listas paginadas (ADR 0005, FEED-09). */
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 50;

/**
 * `limit` de query string: 1 ou mais (0, negativo ou não numérico → 400); acima de 50 é limitado a
 * 50 (FEED-09).
 */
export const PageLimitSchema = z.coerce
  .number({ error: 'Use um número inteiro.' })
  .int({ error: 'Use um número inteiro.' })
  .min(1, { error: 'Use 1 ou mais.' })
  .default(PAGE_SIZE_DEFAULT)
  .transform((value) => Math.min(value, PAGE_SIZE_MAX));

/** Cursor opaco devolvido em `nextCursor`. O app só o repassa. */
export const CursorSchema = z.string().min(1).max(512);

/**
 * `GET /users/:handle/posts?type=&cursor=&limit=` (história 2.6). Sem janela de tempo: todas as
 * publicações da conta, da mais nova para a mais antiga.
 */
export const ProfilePostsQuerySchema = z.object({
  type: PostTypeSchema,
  cursor: CursorSchema.optional(),
  limit: PageLimitSchema,
});
export type ProfilePostsQuery = z.infer<typeof ProfilePostsQuerySchema>;

export const ProfilePostsPageSchema = z.object({
  items: z.array(PostSchema),
  /** `null` na última página. */
  nextCursor: CursorSchema.nullable(),
});
export type ProfilePostsPage = z.infer<typeof ProfilePostsPageSchema>;

// --- comentários (história 2.8, D11) ------------------------------------------------------------

/**
 * Autor de um comentário. `profileVisible` diz se o @ é tocável (D11/A-07): criador sempre; conta
 * pessoal só quando o leitor é a própria pessoa ou uma conexão dela. Com `false`, tocar no @ daria o
 * 404 de perfil, então o app mostra o @ como texto simples.
 */
export const CommentAuthorSchema = PostAuthorSchema.extend({
  profileVisible: z.boolean(),
});
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;

export const CommentSchema = z.object({
  id: uuid,
  /** `null` em comentário de primeiro nível; o id do comentário respondido numa resposta. */
  parentId: uuid.nullable(),
  body: z.string(),
  createdAt: isoDate,
  author: CommentAuthorSchema,
  /** O leitor pode apagar: é o autor do comentário ou do post. */
  canDelete: z.boolean(),
});
export type Comment = z.infer<typeof CommentSchema>;

/** Comentário de primeiro nível com as respostas (1 nível só), em ordem cronológica. */
export const CommentThreadSchema = CommentSchema.extend({
  replies: z.array(CommentSchema),
});
export type CommentThread = z.infer<typeof CommentThreadSchema>;

/** `GET /posts/:id/comments?cursor=&limit=`: a página conta comentários de primeiro nível. */
export const CommentsQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: PageLimitSchema,
});
export type CommentsQuery = z.infer<typeof CommentsQuerySchema>;

export const CommentsPageSchema = z.object({
  items: z.array(CommentThreadSchema),
  nextCursor: CursorSchema.nullable(),
});
export type CommentsPage = z.infer<typeof CommentsPageSchema>;

/**
 * `POST /posts/:id/comments`. Com `parentId`, é uma resposta; responder a uma resposta → 400
 * (1 nível só, 2.8 CA2).
 */
export const CreateCommentRequestSchema = z.strictObject({
  body: CommentBodySchema,
  parentId: uuid.optional(),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>;
export type CreateCommentInput = z.input<typeof CreateCommentRequestSchema>;
