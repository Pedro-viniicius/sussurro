import type { AccountType } from '@sussurro/shared';
import { usePathname } from 'expo-router';

import { profileFor } from '../navigation/routes';

/**
 * As telas de post e de perfil existem dentro de cada aba (`/pessoal/inicio/p/[id]`,
 * `/pessoal/perfil/u/[handle]`…), para a aba de origem continuar ativa (ux.md §3.2). Fora das
 * abas (ex.: a folha de comentários), usa a aba do perfil.
 */
export function tabBaseFrom(pathname: string, accountType: AccountType): string {
  const [group, tab] = pathname.split('/').filter((part) => part !== '');
  if ((group === 'pessoal' || group === 'criador') && tab !== undefined) {
    return `/${group}/${tab}`;
  }
  return profileFor(accountType);
}

export function useTabBase(accountType: AccountType): string {
  return tabBaseFrom(usePathname(), accountType);
}

export function postHref(base: string, postId: string): string {
  return `${base}/p/${encodeURIComponent(postId)}`;
}

/** O próprio @ vai para a aba Perfil; outra conta abre `u/[handle]` dentro da aba atual. */
export function profileHref(
  base: string,
  handle: string,
  me: { handle: string; accountType: AccountType },
): string {
  return handle === me.handle
    ? profileFor(me.accountType)
    : `${base}/u/${encodeURIComponent(handle)}`;
}

/** Folha de comentários (rota na raiz); `origem` diz em que aba abrir um perfil tocado ali. */
export function commentsHref(postId: string, base: string): string {
  return `/comentarios/${encodeURIComponent(postId)}?origem=${encodeURIComponent(base)}`;
}

/**
 * Visualizador de reels (rota na raiz, `fullScreenModal` preto, ux.md §3.2); `origem` diz em que
 * aba abrir um perfil tocado ali (o mesmo dos comentários).
 */
export function reelHref(postId: string, base: string): string {
  return `/reel/${encodeURIComponent(postId)}?origem=${encodeURIComponent(base)}`;
}
