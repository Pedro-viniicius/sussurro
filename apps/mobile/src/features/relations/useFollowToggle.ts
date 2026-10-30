import type { Me } from '@sussurro/shared';
import { useToast } from '@sussurro/ui';
import { useCallback, useRef } from 'react';

import { setFollow } from './api';
import { useFollowStore } from './follow-store';
import { isApiError } from '../../lib/api/errors';
import { messageForError } from '../../lib/error-messages';
import { useAuth } from '../auth/AuthProvider';

/** Toasts da falha ao seguir (3.3 CA6). */
export const FOLLOW_ERROR_MESSAGE = 'Não foi possível seguir.';
export const UNFOLLOW_ERROR_MESSAGE = 'Não foi possível deixar de seguir.';
export const PROFILE_GONE_MESSAGE = 'Este perfil não está mais disponível.';

/** "criadores" do próprio perfil, na hora (3.3 CA1). */
function withCreators(user: Me, delta: number): Me {
  if (user.accountType !== 'personal') return user;
  return {
    ...user,
    counts: { ...user.counts, creators: Math.max(0, user.counts.creators + delta) },
  };
}

function errorMessage(error: unknown, follow: boolean): string {
  if (isApiError(error, 'RATE_LIMITED')) return messageForError(error);
  if (isApiError(error, 'NOT_FOUND')) return PROFILE_GONE_MESSAGE;
  return follow ? FOLLOW_ERROR_MESSAGE : UNFOLLOW_ERROR_MESSAGE;
}

/**
 * Seguir/deixar de seguir otimista (3.3): o botão e o número de "criadores" mudam na hora; na
 * falha (rede, 429, 404) os dois voltam e aparece o Toast. O número de seguidores do criador não
 * muda aqui: ele tem cache de até 60 s no servidor (CNT-02). Depois do sucesso, o `GET /me` acerta
 * o número de "criadores" (o follow pode já existir por outro aparelho).
 *
 * Devolve o estado final (`true` = seguindo).
 */
export function useFollowToggle() {
  const { api, patchUser, reloadUser } = useAuth();
  const follows = useFollowStore();
  const toast = useToast();
  const pending = useRef(new Set<string>());

  return useCallback(
    async (handle: string, following: boolean): Promise<boolean> => {
      if (pending.current.has(handle)) return following;
      pending.current.add(handle);
      const next = !following;
      follows.set(handle, next);
      patchUser((user) => withCreators(user, next ? 1 : -1));
      try {
        const state = await setFollow(api, handle, next);
        follows.set(handle, state.following);
        void reloadUser().catch(() => undefined);
        return state.following;
      } catch (error) {
        follows.set(handle, following);
        patchUser((user) => withCreators(user, next ? -1 : 1));
        toast.show({ message: errorMessage(error, next), variant: 'error' });
        return following;
      } finally {
        pending.current.delete(handle);
      }
    },
    [api, follows, patchUser, reloadUser, toast],
  );
}
