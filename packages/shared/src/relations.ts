import { z } from 'zod';

import { CursorSchema, PageLimitSchema } from './posts.ts';

const isoDate = z.iso.datetime();

// --- seguir (história 3.3) ----------------------------------------------------------------------

/**
 * Resposta de `PUT` e `DELETE /creators/:handle/follow` (idempotentes, PERM-04). Sem o número de
 * seguidores: ele tem cache de 60 s e o app atualiza o botão de forma otimista (CNT-02).
 */
export const FollowStateSchema = z.object({
  following: z.boolean(),
});
export type FollowState = z.infer<typeof FollowStateSchema>;

// --- listas próprias (história 3.6, ADR 0004) ---------------------------------------------------

/**
 * `GET /me/connections`, `GET /me/following` e `GET /me/blocks`: só as listas de quem chama (o
 * `sub` do token). Qualquer parâmetro além de `cursor` e `limit` (`?userId=`, `?handle=`) → 400
 * (PERM-08). Não existe rota com o id ou o @ de outra conta que devolva lista (PERM-09).
 */
export const OwnListQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: PageLimitSchema,
});
export type OwnListQuery = z.infer<typeof OwnListQuerySchema>;

/**
 * Uma conta numa lista própria ("Conexões" e "Criadores que sigo", ux.md §4.8), da mais recente
 * para a mais antiga. `since`: desde quando é conexão ou seguido. Contas excluídas não aparecem.
 */
export const OwnListItemSchema = z.object({
  handle: z.string(),
  name: z.string(),
  avatarUrl: z.url().nullable(),
  since: isoDate,
});
export type OwnListItem = z.infer<typeof OwnListItemSchema>;

/** Página de `GET /me/connections` (só conta pessoal). */
export const ConnectionsPageSchema = z.object({
  items: z.array(OwnListItemSchema),
  nextCursor: CursorSchema.nullable(),
});
export type ConnectionsPage = z.infer<typeof ConnectionsPageSchema>;

/** Página de `GET /me/following` (só conta pessoal). */
export const FollowingPageSchema = z.object({
  items: z.array(OwnListItemSchema),
  nextCursor: CursorSchema.nullable(),
});
export type FollowingPage = z.infer<typeof FollowingPageSchema>;

// --- bloquear (X.2) -----------------------------------------------------------------------------

/**
 * `POST /me/blocks` (qualquer tipo de conta): bloqueia pelo @ ou pelo autor de um comentário que a
 * pessoa vê (D11: o @ de quem comenta aparece mesmo sem o perfil ser visível). A resposta é sempre
 * 204, inclusive para @ inexistente ou que a pessoa não pode ver (nesses casos nada é gravado):
 * bloquear não vira oráculo de existência de @ pessoal.
 */
export const BlockRequestSchema = z.union([
  z.strictObject({ handle: z.string().min(1).max(64) }),
  z.strictObject({ commentId: z.uuid({ error: 'Identificador inválido.' }) }),
]);
export type BlockRequest = z.infer<typeof BlockRequestSchema>;

/**
 * Uma conta na lista de bloqueados. Só o @ e a data: quem bloqueia não volta a ver nome nem foto
 * de quem bloqueou (e o @ ela já conhecia).
 */
export const BlockedAccountSchema = z.object({
  handle: z.string(),
  blockedAt: isoDate,
});
export type BlockedAccount = z.infer<typeof BlockedAccountSchema>;

/** Página de `GET /me/blocks` (só o dono; desbloquear: `DELETE /me/blocks/:handle`). */
export const BlocksPageSchema = z.object({
  items: z.array(BlockedAccountSchema),
  nextCursor: CursorSchema.nullable(),
});
export type BlocksPage = z.infer<typeof BlocksPageSchema>;
