import { z } from 'zod';

import { MediaItemRequestSchema, UploadTargetSchema } from './posts.ts';

// --- avatar (história 2.4) ------------------------------------------------------------------------

/** `POST /me/avatar/upload-url`: mesmo tipo e limite das fotos (MID-13). */
export const AvatarUploadRequestSchema = MediaItemRequestSchema;
export type AvatarUploadRequest = z.infer<typeof AvatarUploadRequestSchema>;

/** URL PUT pré-assinada para a foto de perfil (201). */
export const AvatarUploadSchema = UploadTargetSchema.extend({
  uploadId: z.uuid(),
});
export type AvatarUpload = z.infer<typeof AvatarUploadSchema>;

/** `PUT /me/avatar`: troca a foto pelo upload já enviado. Idempotente. */
export const SetAvatarRequestSchema = z.strictObject({
  uploadId: z.uuid({ error: 'Identificador inválido.' }),
});
export type SetAvatarRequest = z.infer<typeof SetAvatarRequestSchema>;

/**
 * Estado da troca de foto. O processamento é assíncrono (o mesmo pipeline das fotos: sem
 * metadados): o app repete o `PUT /me/avatar` com o mesmo `uploadId` até sair de `processing`.
 * `avatarUrl` é a foto em uso agora (a nova quando `ready`).
 */
export const AvatarStatusSchema = z.object({
  uploadId: z.uuid(),
  status: z.enum(['processing', 'ready', 'failed']),
  avatarUrl: z.url().nullable(),
});
export type AvatarStatus = z.infer<typeof AvatarStatusSchema>;

// --- fila media-jobs (API → worker) ------------------------------------------------------------

/**
 * Mensagem da fila `media-jobs` (ADR 0009): uma por imagem de post, uma por troca de avatar e (Fase
 * 5, ADR 0006) uma por vídeo de reel, que o worker entrega ao `VideoProcessor`. Só leva ids; o
 * worker lê o resto do banco.
 */
export const MediaJobMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('post-media'), mediaId: z.uuid() }),
  z.object({ type: z.literal('avatar'), uploadId: z.uuid() }),
  z.object({ type: z.literal('post-video'), mediaId: z.uuid() }),
]);
export type MediaJobMessage = z.infer<typeof MediaJobMessageSchema>;
