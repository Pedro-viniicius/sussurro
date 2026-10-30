import { z } from 'zod';

import { CursorSchema, PageLimitSchema, PostSchema, PostTypeSchema } from './posts.ts';

/** Janela padrão do feed (ADR 0005). O valor real vem da API em `windowHours`. */
export const FEED_WINDOW_HOURS_DEFAULT = 72;

/**
 * `GET /feed?type=photo|text|reel&cursor=&limit=` (história 2.5, só conta pessoal). `type` é
 * obrigatório (FEED-05). O cursor carrega a aba e o início da janela: o de outra aba → 400.
 */
export const FeedQuerySchema = z.object({
  type: PostTypeSchema,
  cursor: CursorSchema.optional(),
  limit: PageLimitSchema,
});
export type FeedQuery = z.infer<typeof FeedQuerySchema>;

/**
 * Página do feed (ADR 0005): posts das conexões, dos criadores seguidos e da própria pessoa (D9),
 * em ordem `publishedAt` desc com desempate por id, dentro da janela de `windowHours` fixada na
 * primeira página. `caughtUp = true` na última página ("Você está em dia").
 */
export const FeedPageSchema = z.object({
  items: z.array(PostSchema),
  nextCursor: CursorSchema.nullable(),
  caughtUp: z.boolean(),
  windowHours: z.int().positive(),
});
export type FeedPage = z.infer<typeof FeedPageSchema>;

/**
 * Texto do "Você está em dia" a partir de `windowHours` (FEED-04): 72 → "últimos 3 dias",
 * 24 → "último dia", 36 → "últimas 36 horas", 1 → "última hora".
 */
export function feedWindowLabel(windowHours: number): string {
  if (windowHours % 24 === 0) {
    const days = windowHours / 24;
    return days === 1 ? 'último dia' : `últimos ${String(days)} dias`;
  }
  return windowHours === 1 ? 'última hora' : `últimas ${String(windowHours)} horas`;
}
