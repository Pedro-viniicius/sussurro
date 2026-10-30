import type { Post } from '@sussurro/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { usePostStore } from './post-store';
import { isApiError } from '../../lib/api/errors';

export interface PostPage {
  items: Post[];
  nextCursor: string | null;
  /** Só no feed: última página da janela ("Você está em dia"). */
  caughtUp?: boolean;
  /** Só no feed: a janela usada (FEED-04). */
  windowHours?: number;
}

export type ListStatus = 'loading' | 'error' | 'ready';

export interface PostPagesState {
  ids: string[];
  status: ListStatus;
  /** Erro da primeira página (para a mensagem). */
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  /** A página seguinte falhou: a lista fica e aparece "Não carregou. Tentar de novo". */
  loadMoreFailed: boolean;
  refreshing: boolean;
  caughtUp: boolean;
  windowHours: number | null;
}

const INITIAL: PostPagesState = {
  ids: [],
  status: 'loading',
  error: null,
  hasMore: false,
  loadingMore: false,
  loadMoreFailed: false,
  refreshing: false,
  caughtUp: false,
  windowHours: null,
};

/** Cursor recusado pela API (adulterado, vencido ou de outra aba): recomeça da primeira página. */
export function isCursorError(error: unknown): boolean {
  return isApiError(error, 'VALIDATION_ERROR') && error.fieldPaths().includes('cursor');
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Lista paginada por cursor opaco (feed e abas do perfil). Os posts vão para o `PostStore`; aqui
 * ficam só os ids, a ordem e os estados de carregamento (ux.md §5.1).
 */
/**
 * `fetchPage` precisa ser estável (useCallback): quando muda (outra aba, outro perfil), a lista
 * recomeça.
 */
export function usePostPages(
  fetchPage: (cursor?: string) => Promise<PostPage>,
  options: { enabled?: boolean; onRefreshError?: (error: unknown) => void } = {},
) {
  const { enabled = true, onRefreshError } = options;
  const store = usePostStore();
  const [state, setState] = useState<PostPagesState>(INITIAL);
  const cursor = useRef<string | null>(null);
  // Respostas de uma geração antiga (outra aba, recomeço) são ignoradas.
  const generation = useRef(0);

  const applyFirstPage = useCallback(
    (page: PostPage, extra: Partial<PostPagesState> = {}) => {
      store.upsert(page.items);
      cursor.current = page.nextCursor;
      setState({
        ...INITIAL,
        status: 'ready',
        ids: unique(page.items.map((post) => post.id)),
        hasMore: page.nextCursor !== null,
        caughtUp: page.caughtUp ?? page.nextCursor === null,
        windowHours: page.windowHours ?? null,
        ...extra,
      });
    },
    [store],
  );

  /** Primeira página de uma geração nova; o estado só muda quando a resposta chega. */
  const fetchFirst = useCallback((): Promise<void> => {
    generation.current += 1;
    const current = generation.current;
    cursor.current = null;
    return fetchPage().then(
      (page) => {
        if (current === generation.current) applyFirstPage(page);
      },
      (error: unknown) => {
        if (current === generation.current) setState({ ...INITIAL, status: 'error', error });
      },
    );
  }, [applyFirstPage, fetchPage]);

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    // Só a resposta muda o estado (a lista começa em "carregando").
    void Promise.resolve().then(() => (active ? fetchFirst() : undefined));
    return () => {
      active = false;
    };
  }, [enabled, fetchFirst]);

  /** "Tentar de novo" e recomeço depois de um cursor recusado: volta ao carregando. */
  const loadFirst = useCallback(async () => {
    setState(INITIAL);
    await fetchFirst();
  }, [fetchFirst]);

  const refresh = useCallback(async () => {
    generation.current += 1;
    const current = generation.current;
    setState((value) => ({ ...value, refreshing: true }));
    try {
      const page = await fetchPage();
      if (current === generation.current) applyFirstPage(page);
    } catch (error) {
      if (current !== generation.current) return;
      setState((value) => ({ ...value, refreshing: false }));
      onRefreshError?.(error);
    }
  }, [applyFirstPage, fetchPage, onRefreshError]);

  const loadMore = useCallback(async () => {
    const next = cursor.current;
    if (next === null || state.loadingMore || state.status !== 'ready') return;
    const current = generation.current;
    setState((value) => ({ ...value, loadingMore: true, loadMoreFailed: false }));
    try {
      const page = await fetchPage(next);
      if (current !== generation.current) return;
      store.upsert(page.items);
      cursor.current = page.nextCursor;
      setState((value) => ({
        ...value,
        ids: unique([...value.ids, ...page.items.map((post) => post.id)]),
        hasMore: page.nextCursor !== null,
        loadingMore: false,
        caughtUp: page.caughtUp ?? page.nextCursor === null,
        windowHours: page.windowHours ?? value.windowHours,
      }));
    } catch (error) {
      if (current !== generation.current) return;
      if (isCursorError(error)) {
        // Cursor inválido (ex.: janela vencida): recomeça da primeira página.
        await loadFirst();
        return;
      }
      setState((value) => ({ ...value, loadingMore: false, loadMoreFailed: true }));
    }
  }, [fetchPage, loadFirst, state.loadingMore, state.status, store]);

  /** Post novo do próprio usuário no topo (sem duplicar). */
  const prepend = useCallback((postId: string) => {
    setState((value) =>
      value.status === 'ready' ? { ...value, ids: unique([postId, ...value.ids]) } : value,
    );
  }, []);

  return { ...state, reload: loadFirst, refresh, loadMore, prepend };
}
