import type { AccountType } from '@sussurro/shared';
import { usePathname } from 'expo-router';

import { isTabBase, profileFor, type ProfileRoute, type TabBase } from '../navigation/routes';

/**
 * As telas de post e de perfil existem dentro de cada aba (`/pessoal/inicio/p/[id]`,
 * `/pessoal/perfil/u/[handle]`…), para a aba de origem continuar ativa (ux.md §3.2). Fora das
 * abas (ex.: a folha de comentários) ou numa aba sem essas telas, usa a aba do perfil.
 */
export function tabBaseFrom(pathname: string, accountType: AccountType): TabBase {
  const [group, tab] = pathname.split('/').filter((part) => part !== '');
  if ((group === 'pessoal' || group === 'criador') && tab !== undefined) {
    const base = `/${group}/${tab}`;
    if (isTabBase(base)) return base;
  }
  return profileFor(accountType);
}

/**
 * A aba de origem que veio na query (`origem`, da folha de comentários e do visualizador de
 * reels). Valor desconhecido (link montado à mão) cai na aba do perfil.
 */
export function tabBaseFromQuery(origem: string | undefined, accountType: AccountType): TabBase {
  return origem !== undefined && isTabBase(origem) ? origem : profileFor(accountType);
}

export function useTabBase(accountType: AccountType): TabBase {
  return tabBaseFrom(usePathname(), accountType);
}

export function postHref(base: TabBase, postId: string): `${TabBase}/p/${string}` {
  return `${base}/p/${encodeURIComponent(postId)}`;
}

/** O próprio @ vai para a aba Perfil; outra conta abre `u/[handle]` dentro da aba atual. */
export function profileHref(
  base: TabBase,
  handle: string,
  me: { handle: string; accountType: AccountType },
): ProfileRoute | `${TabBase}/u/${string}` {
  return handle === me.handle
    ? profileFor(me.accountType)
    : `${base}/u/${encodeURIComponent(handle)}`;
}

/** Folha de comentários (rota na raiz); `origem` diz em que aba abrir um perfil tocado ali. */
export function commentsHref(postId: string, base: TabBase): `/comentarios/${string}` {
  return `/comentarios/${encodeURIComponent(postId)}?origem=${encodeURIComponent(base)}`;
}

/**
 * Visualizador de reels (rota na raiz, `fullScreenModal` preto, ux.md §3.2); `origem` diz em que
 * aba abrir um perfil tocado ali (o mesmo dos comentários).
 */
export function reelHref(postId: string, base: TabBase): `/reel/${string}` {
  return `/reel/${encodeURIComponent(postId)}?origem=${encodeURIComponent(base)}`;
}
