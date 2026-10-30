/**
 * Formas simples que os componentes de post recebem (ux.md §6: o design system não conhece os
 * tipos da API; o app faz o mapeamento).
 */
export interface PostAuthorView {
  handle: string;
  name?: string;
  avatarUri?: string | null;
  /** Semente da cor do avatar sem foto (id da conta, quando houver). */
  seed?: string;
}

/** Rótulo do autor: "Conexão" (pessoal), "Criador" ou nada (o próprio leitor). */
export type PostRelation = 'connection' | 'creator' | 'self';

export const RELATION_LABEL: Record<PostRelation, string | null> = {
  connection: 'Conexão',
  creator: 'Criador',
  self: null,
};
