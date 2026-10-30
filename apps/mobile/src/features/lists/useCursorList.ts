import { useCallback, useEffect, useRef, useState } from 'react';

import { isCursorError } from '../posts/usePostPages';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CursorListState<T> {
  items: T[];
  status: 'loading' | 'error' | 'ready';
  /** Erro da primeira página (para a mensagem). */
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  /** A página seguinte falhou: a lista fica e aparece "Não carregou. Tentar de novo". */
  loadMoreFailed: boolean;
  refreshing: boolean;
}

function initial<T>(): CursorListState<T> {
  return {
    items: [],
    status: 'loading',
    error: null,
    hasMore: false,
    loadingMore: false,
    loadMoreFailed: false,
    refreshing: false,
  };
}

/**
 * Lista paginada por cursor opaco que não é de posts (listas próprias e bloqueados, ux.md §5.1:
 * skeleton, "Tentar de novo", "Não carregou" na página seguinte e puxar para atualizar). Itens
 * repetidos entre páginas (pela `keyOf`) entram uma vez só. `fetchPage` precisa ser estável.
 */
export function useCursorList<T>(
  fetchPage: (cursor?: string) => Promise<CursorPage<T>>,
  keyOf: (item: T) => string,
) {
  const [state, setState] = useState<CursorListState<T>>(initial);
  const cursor = useRef<string | null>(null);
  const generation = useRef(0);

  const unique = useCallback(
    (items: readonly T[]): T[] => {
      const seen = new Set<string>();
      return items.filter((item) => {
        const key = keyOf(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    [keyOf],
  );

  const applyFirstPage = useCallback(
    (page: CursorPage<T>) => {
      cursor.current = page.nextCursor;
      setState({
        ...initial<T>(),
        status: 'ready',
        items: unique(page.items),
        hasMore: page.nextCursor !== null,
      });
    },
    [unique],
  );

  const fetchFirst = useCallback((): Promise<void> => {
    generation.current += 1;
    const current = generation.current;
    cursor.current = null;
    return fetchPage().then(
      (page) => {
        if (current === generation.current) applyFirstPage(page);
      },
      (error: unknown) => {
        if (current === generation.current) setState({ ...initial<T>(), status: 'error', error });
      },
    );
  }, [applyFirstPage, fetchPage]);

  useEffect(() => {
    let active = true;
    // Só a resposta muda o estado (a lista começa em "carregando").
    void Promise.resolve().then(() => (active ? fetchFirst() : undefined));
    return () => {
      active = false;
    };
  }, [fetchFirst]);

  /** "Tentar de novo" e recomeço depois de um cursor recusado. */
  const reload = useCallback(async () => {
    setState(initial<T>());
    await fetchFirst();
  }, [fetchFirst]);

  const refresh = useCallback(async () => {
    generation.current += 1;
    const current = generation.current;
    setState((value) => ({ ...value, refreshing: true }));
    try {
      const page = await fetchPage();
      if (current === generation.current) applyFirstPage(page);
    } catch {
      if (current === generation.current) {
        setState((value) => ({ ...value, refreshing: false }));
      }
    }
  }, [applyFirstPage, fetchPage]);

  const loadMore = useCallback(async () => {
    const next = cursor.current;
    if (next === null || state.loadingMore || state.status !== 'ready') return;
    const current = generation.current;
    setState((value) => ({ ...value, loadingMore: true, loadMoreFailed: false }));
    try {
      const page = await fetchPage(next);
      if (current !== generation.current) return;
      cursor.current = page.nextCursor;
      setState((value) => ({
        ...value,
        items: unique([...value.items, ...page.items]),
        hasMore: page.nextCursor !== null,
        loadingMore: false,
      }));
    } catch (error) {
      if (current !== generation.current) return;
      if (isCursorError(error)) {
        await reload();
        return;
      }
      setState((value) => ({ ...value, loadingMore: false, loadMoreFailed: true }));
    }
  }, [fetchPage, reload, state.loadingMore, state.status, unique]);

  /** Tira um item da lista (ex.: conta desbloqueada). */
  const remove = useCallback(
    (key: string) => {
      setState((value) => ({ ...value, items: value.items.filter((item) => keyOf(item) !== key) }));
    },
    [keyOf],
  );

  return { ...state, reload, refresh, loadMore, remove };
}
