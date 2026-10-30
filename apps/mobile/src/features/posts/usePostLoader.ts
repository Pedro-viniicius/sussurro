import type { Post } from '@sussurro/shared';
import { useCallback, useEffect, useState } from 'react';

import { fetchPost } from './api';
import { usePost, usePostStore } from './post-store';
import { isApiError } from '../../lib/api/errors';
import { useAuth } from '../auth/AuthProvider';

export type PostLoadStatus = 'loading' | 'ready' | 'notFound' | 'error';

/**
 * Um post pelo id: mostra na hora o que o store já tem e busca a versão atual (`GET /posts/:id`).
 * 404 (apagado, sem acesso ou inexistente: a API não diferencia) vira `notFound`.
 */
export function usePostLoader(postId: string): {
  post: Post | undefined;
  status: PostLoadStatus;
  reload: () => void;
} {
  const { api } = useAuth();
  const store = usePostStore();
  const post = usePost(postId);
  const [fetched, setFetched] = useState<'pending' | 'ok' | 'notFound' | 'error'>('pending');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    fetchPost(api, postId)
      .then((fresh) => {
        if (!active) return;
        store.upsert([fresh]);
        setFetched('ok');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFetched(isApiError(error, 'NOT_FOUND') ? 'notFound' : 'error');
      });
    return () => {
      active = false;
    };
  }, [api, postId, store, attempt]);

  const reload = useCallback(() => {
    setFetched('pending');
    setAttempt((value) => value + 1);
  }, []);

  const status: PostLoadStatus =
    store.isDeleted(postId) || fetched === 'notFound'
      ? 'notFound'
      : post !== undefined
        ? 'ready'
        : fetched === 'error'
          ? 'error'
          : 'loading';

  return { post, status, reload };
}
