import { z } from 'zod';

import { HANDLE_MAX_LENGTH } from './handles.ts';

/** Mínimo de caracteres da busca, contados depois de normalizar (BUS-01, BUS-02). */
export const CREATOR_SEARCH_MIN_LENGTH = 3;
/** Máximo: o tamanho de um @ (BUS-09). */
export const CREATOR_SEARCH_MAX_LENGTH = HANDLE_MAX_LENGTH;
/** Teto fixo de resultados, sem paginação: a pessoa refina o prefixo (A-31). */
export const CREATOR_SEARCH_MAX_RESULTS = 20;

/** Teto bruto antes de normalizar: barra entradas absurdas sem custo. */
const RAW_SEARCH_GUARD = 100;

/**
 * Normaliza o que a pessoa digitou (BUS-02, BUS-03): sem espaços nas pontas, sem o `@` inicial e
 * em minúsculas. `" @Estu "` → `"estu"`. O app usa a mesma função para decidir se chama a API.
 */
export function normalizeCreatorSearch(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('@')) {
    value = value.slice(1).trim();
  }
  return value.toLowerCase();
}

/**
 * Termo da busca já normalizado: 3 a 30 caracteres de `[a-z0-9._]` (o alfabeto do @). Qualquer
 * outro caractere (`%`, `'`, espaço no meio, acento) → 400, nunca 500 (BUS-06). O `_` e o `.`
 * são texto: o servidor escapa o LIKE.
 */
export const CreatorSearchTermSchema = z
  .string({ error: 'Digite o @ de um criador.' })
  .max(RAW_SEARCH_GUARD, { error: `Use no máximo ${CREATOR_SEARCH_MAX_LENGTH} caracteres.` })
  .transform(normalizeCreatorSearch)
  .pipe(
    z
      .string()
      .min(CREATOR_SEARCH_MIN_LENGTH, { error: 'Digite pelo menos 3 letras.' })
      .max(CREATOR_SEARCH_MAX_LENGTH, {
        error: `Use no máximo ${CREATOR_SEARCH_MAX_LENGTH} caracteres.`,
      })
      .regex(/^[a-z0-9._]+$/, { error: 'Use só letras, números, ponto e sublinhado.' }),
  );

/** O termo já pode ir para a API (BUS-11: com 1 ou 2 letras o app nem chama). */
export function isCreatorSearchReady(raw: string): boolean {
  return CreatorSearchTermSchema.safeParse(raw).success;
}

/**
 * `GET /search/creators?q=` (história 3.1, só conta pessoal). Parâmetro a mais → 400. Rate limit
 * por conta (A-31).
 */
export const SearchCreatorsQuerySchema = z.strictObject({
  q: CreatorSearchTermSchema,
});
export type SearchCreatorsQuery = z.infer<typeof SearchCreatorsQuerySchema>;

/**
 * Um criador no resultado (BUS-10): só @, nome, avatar, número de seguidores (o mesmo cache de
 * 60 s do perfil) e se o leitor já segue. Nunca conta pessoal (BUS-04, BUS-05).
 */
export const CreatorSearchItemSchema = z.object({
  handle: z.string(),
  name: z.string(),
  avatarUrl: z.url().nullable(),
  followersCount: z.int().min(0),
  followedByMe: z.boolean(),
});
export type CreatorSearchItem = z.infer<typeof CreatorSearchItemSchema>;

/**
 * Resultado da busca: até 20 criadores em ordem alfabética do @. Sem criador com o prefixo,
 * `items: []`, idêntico para um @ pessoal existente e um @ inexistente (A-04, BUS-05).
 */
export const CreatorSearchResultSchema = z.object({
  items: z.array(CreatorSearchItemSchema).max(CREATOR_SEARCH_MAX_RESULTS),
});
export type CreatorSearchResult = z.infer<typeof CreatorSearchResultSchema>;
