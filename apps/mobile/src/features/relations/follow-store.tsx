import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';

type Listener = () => void;

/**
 * Se a pessoa segue cada criador, compartilhado entre a busca, o perfil do criador e "Criadores
 * que sigo": seguir no perfil e voltar à busca já mostra "Seguindo". A resposta do servidor (busca,
 * perfil, lista) entra por `merge`; o toque no botão muda na hora por `set` (3.3 CA6).
 */
export class FollowStore {
  private readonly following = new Map<string, boolean>();
  private readonly listeners = new Set<Listener>();

  /** Conta dona destes dados (um store novo a cada sessão). */
  constructor(readonly ownerId: string | null = null) {}

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get(handle: string): boolean | undefined {
    return this.following.get(handle);
  }

  set(handle: string, value: boolean): void {
    if (this.following.get(handle) === value) return;
    this.following.set(handle, value);
    this.emit();
  }

  /** Dados novos do servidor (a resposta mais recente vence). */
  merge(entries: readonly (readonly [string, boolean])[]): void {
    let changed = false;
    for (const [handle, value] of entries) {
      if (this.following.get(handle) !== value) {
        this.following.set(handle, value);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const FollowStoreContext = createContext<FollowStore | null>(null);

/** Um store por sessão, como o de posts. */
export function FollowStoreProvider({
  userId,
  children,
}: {
  userId: string | null;
  children: ReactNode;
}) {
  const store = useMemo(() => new FollowStore(userId), [userId]);
  return <FollowStoreContext.Provider value={store}>{children}</FollowStoreContext.Provider>;
}

export function useFollowStore(): FollowStore {
  const store = useContext(FollowStoreContext);
  if (store === null) {
    throw new Error('useFollowStore precisa de um <FollowStoreProvider> acima na árvore.');
  }
  return store;
}

/** Segue o criador `handle`? O que o store sabe vence o `fallback` (o valor da tela). */
export function useFollowing(handle: string, fallback: boolean): boolean {
  const store = useFollowStore();
  const getSnapshot = useCallback(() => store.get(handle) ?? fallback, [store, handle, fallback]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Dos @ dados, os que a pessoa deixou de seguir nesta sessão (somem de "Criadores que sigo"). */
export function useUnfollowed(handles: readonly string[]): ReadonlySet<string> {
  const store = useFollowStore();
  // Uma string estável como snapshot: muda só quando algum @ entra ou sai.
  const getSnapshot = useCallback(
    () => handles.filter((handle) => store.get(handle) === false).join('|'),
    [store, handles],
  );
  const joined = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  return useMemo(() => new Set(joined === '' ? [] : joined.split('|')), [joined]);
}
