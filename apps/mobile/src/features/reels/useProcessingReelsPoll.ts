import { useToast } from '@sussurro/ui';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { FAILED_REEL_TITLE, reelTileStatus } from './ReelGridTile';
import { isApiError } from '../../lib/api/errors';
import { useAuth } from '../auth/AuthProvider';
import { useAppActive } from '../connect/hooks';
import {
  MAX_POLL_ERRORS,
  MAX_REEL_POLL_DELAY_MS,
  PUBLISHED_MESSAGE,
  usePublishing,
} from '../create/PublishingProvider';
import { fetchPost } from '../posts/api';
import { type PostStore, usePostStore } from '../posts/post-store';

/** O tile do reel está em "Processando" e não tem faixa nesta sessão. */
function isPendingReel(store: PostStore, postId: string, banners: readonly string[]): boolean {
  const post = store.get(postId);
  return (
    post?.type === 'reel' && reelTileStatus(post) === 'processing' && !banners.includes(postId)
  );
}

/**
 * O tile "Processando" de um reel de outra sessão (ux.md §12.3): na aba Reels do próprio perfil,
 * os reels em processamento que não têm faixa nesta sessão são consultados (`GET /v1/posts/:id`,
 * um por vez) enquanto valem as três condições juntas: `active` (a tela do perfil em foco e a aba
 * Reels visível) e o app em primeiro plano. Quando elas passam a valer, consulta na hora; depois, a
 * cada 10 s (`MAX_REEL_POLL_DELAY_MS`, o teto da faixa).
 *
 * - O resultado vai para o `PostStore`, e o tile muda no lugar. Pronto: Toast "Publicado.". Falhou:
 *   Toast "Não foi possível publicar este reel.". 404: o tile sai, sem Toast.
 * - Falha de rede: o tile fica, sem Toast. Depois de 5 seguidas de um reel (`MAX_POLL_ERRORS`), ele
 *   deixa de ser consultado até as condições voltarem a valer.
 * - Para quando não sobra tile "Processando" ou quando uma condição deixa de valer (a resposta que
 *   chega depois é ignorada).
 */
export function useProcessingReelsPoll(ids: readonly string[], active: boolean): void {
  const { api } = useAuth();
  const store = usePostStore();
  const toast = useToast();
  const { jobs } = usePublishing();
  const appActive = useAppActive();

  // O reel com faixa nesta sessão já é consultado pelo `PublishingProvider`.
  const jobPostIds = jobs.map((job) => job.postId).filter((postId) => postId !== null);
  const latest = useRef({ ids, jobPostIds, toast });
  useEffect(() => {
    latest.current = { ids, jobPostIds, toast };
  });

  // Sobra tile "Processando" a consultar? Muda quando um tile sai do "Processando" (ou entra).
  const hasPending = useSyncExternalStore(store.subscribe, () =>
    ids.some((postId) => isPendingReel(store, postId, jobPostIds)),
  );

  const running = active && appActive && hasPending;

  useEffect(() => {
    if (!running) return undefined;
    let cancelled = false;
    // Lido sempre de novo: a limpeza pode chegar durante qualquer await.
    const stopped = (): boolean => cancelled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Falhas de rede seguidas por reel: zeram quando as condições voltam a valer.
    const errors = new Map<string, number>();
    const polling = (postId: string): boolean => (errors.get(postId) ?? 0) < MAX_POLL_ERRORS;
    // Lidos a cada ciclo: os ids e as faixas de agora.
    const pending = (): string[] => {
      const { ids: current, jobPostIds: banners } = latest.current;
      return current.filter((postId) => isPendingReel(store, postId, banners) && polling(postId));
    };

    const cycle = async (): Promise<void> => {
      for (const postId of pending()) {
        if (stopped()) return;
        try {
          const post = await fetchPost(api, postId);
          if (stopped()) return;
          errors.delete(postId);
          store.upsert([post]);
          const status = reelTileStatus(post);
          if (status === 'ready') {
            latest.current.toast.show({ message: PUBLISHED_MESSAGE, variant: 'success' });
          } else if (status === 'failed') {
            latest.current.toast.show({ message: FAILED_REEL_TITLE, variant: 'error' });
          }
        } catch (error) {
          if (stopped()) return;
          if (isApiError(error, 'NOT_FOUND')) {
            // Apagado (por exemplo, em outro celular): o tile sai, sem Toast.
            store.remove(postId);
          } else {
            errors.set(postId, (errors.get(postId) ?? 0) + 1);
          }
        }
      }
      if (stopped() || pending().length === 0) return;
      timer = setTimeout(() => {
        void cycle();
      }, MAX_REEL_POLL_DELAY_MS);
    };

    void cycle();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, running, store]);
}
