import { useToast } from '@sussurro/ui';
import { useCallback, useRef } from 'react';

import { setLike } from './api';
import { usePostStore } from './post-store';
import { useAuth } from '../auth/AuthProvider';

/** Toast da curtida que falhou (ux.md §5.4, 2.7 CA5). */
export const LIKE_ERROR_MESSAGE = 'Não foi possível curtir.';

/**
 * Curtir/descurtir otimista (2.7): o coração e o número mudam na hora; a resposta da API acerta o
 * número; na falha (rede ou servidor) o coração volta ao estado anterior e aparece o Toast.
 */
export function useLike() {
  const store = usePostStore();
  const { api } = useAuth();
  const toast = useToast();
  const pending = useRef(new Set<string>());

  return useCallback(
    async (postId: string) => {
      const post = store.get(postId);
      if (post === undefined || pending.current.has(postId)) return;
      pending.current.add(postId);
      const previous = { likedByMe: post.likedByMe, likeCount: post.likeCount };
      const liked = !post.likedByMe;
      store.patch(postId, {
        likedByMe: liked,
        likeCount: Math.max(0, post.likeCount + (liked ? 1 : -1)),
      });
      try {
        store.patch(postId, await setLike(api, postId, liked));
      } catch {
        store.patch(postId, previous);
        toast.show({ message: LIKE_ERROR_MESSAGE, variant: 'error' });
      } finally {
        pending.current.delete(postId);
      }
    },
    [api, store, toast],
  );
}
