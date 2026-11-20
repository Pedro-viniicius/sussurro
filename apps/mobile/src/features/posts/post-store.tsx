import type { Post } from '@sussurro/shared';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';

type Listener = () => void;
type CreatedListener = (post: Post) => void;

/**
 * Última versão conhecida de cada post, compartilhada entre o feed, o perfil, o detalhe e os
 * comentários: curtir no detalhe atualiza o feed; apagar some de todas as listas na hora (2.9 CA1).
 * As listas guardam só os ids, e cada item lê o post daqui. Também guarda os @ bloqueados nesta
 * sessão (X.2): os posts, os comentários e as linhas dessas contas somem das listas já carregadas,
 * sem esperar recarregar.
 */
export class PostStore {
  private readonly posts = new Map<string, Post>();
  private readonly deleted = new Set<string>();
  private hidden: ReadonlySet<string> = new Set<string>();
  /** @ de conexões desfeitas nesta sessão (D8): as publicações e a linha da lista somem. */
  private disconnected: ReadonlySet<string> = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly createdListeners = new Set<CreatedListener>();
  private feedStaleVersion = 0;

  /** Conta dona destes dados (um store novo a cada sessão). */
  constructor(readonly ownerId: string | null = null) {}

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get(id: string): Post | undefined {
    if (this.deleted.has(id)) return undefined;
    const post = this.posts.get(id);
    return post !== undefined && this.isHiddenAuthor(post.author.handle) ? undefined : post;
  }

  private isHiddenAuthor(handle: string): boolean {
    return this.hidden.has(handle) || this.disconnected.has(handle);
  }

  /** Apagado ou de uma conta bloqueada: some das listas e o detalhe vira "não disponível". */
  isDeleted(id: string): boolean {
    if (this.deleted.has(id)) return true;
    const post = this.posts.get(id);
    return post !== undefined && this.isHiddenAuthor(post.author.handle);
  }

  /** @ bloqueados nesta sessão (um conjunto novo a cada mudança). */
  hiddenAuthors = (): ReadonlySet<string> => this.hidden;

  /** Bloqueou (X.2): tudo o que é da conta some na hora. */
  hideAuthor(handle: string): void {
    if (this.hidden.has(handle)) return;
    this.hidden = new Set([...this.hidden, handle]);
    this.emit();
  }

  /** Desbloqueou: o que voltar a vir da API volta a aparecer. */
  showAuthor(handle: string): void {
    if (!this.hidden.has(handle)) return;
    this.hidden = new Set([...this.hidden].filter((value) => value !== handle));
    this.emit();
  }

  /**
   * Desfez a conexão (D8): as publicações da pessoa (conta pessoal, só vistas por conexões) somem
   * das listas já carregadas. Os comentários dela em posts de criadores continuam.
   */
  hidePostsOf(handle: string): void {
    if (this.disconnected.has(handle)) return;
    this.disconnected = new Set([...this.disconnected, handle]);
    this.emit();
  }

  /** Conectou de novo (ou o desfazer falhou): o que vier da API volta a aparecer. */
  showPostsOf(handle: string): void {
    if (!this.disconnected.has(handle)) return;
    this.disconnected = new Set([...this.disconnected].filter((value) => value !== handle));
    this.emit();
  }

  /** @ de conexões desfeitas nesta sessão (um conjunto novo a cada mudança). */
  disconnectedAuthors = (): ReadonlySet<string> => this.disconnected;

  /** Guarda o que veio da API (a resposta do servidor sempre vence). */
  upsert(posts: readonly Post[]): void {
    if (posts.length === 0) return;
    for (const post of posts) {
      this.posts.set(post.id, post);
    }
    this.emit();
  }

  patch(id: string, changes: Partial<Post>): void {
    const current = this.posts.get(id);
    if (current === undefined) return;
    this.posts.set(id, { ...current, ...changes });
    this.emit();
  }

  remove(id: string): void {
    this.deleted.add(id);
    this.emit();
  }

  /** Post novo do próprio usuário (publicado agora): o feed e o perfil põem no topo. */
  announceCreated(post: Post): void {
    this.posts.set(post.id, post);
    this.emit();
    for (const listener of this.createdListeners) listener(post);
  }

  /**
   * Versão do Início (ux.md §12.2): sobe a cada ação que deixa o feed desatualizado (seguir dá
   * certo, conexão nova). Cada aba do Início guarda a versão da última primeira página buscada e,
   * com uma versão mais nova, busca de novo quando volta a ficar em foco e visível. Várias ações
   * seguidas dão uma busca só.
   */
  get feedVersion(): number {
    return this.feedStaleVersion;
  }

  /** Seguiu um criador ou conectou com alguém: o Início busca de novo na próxima volta ao foco. */
  markFeedStale(): void {
    this.feedStaleVersion += 1;
  }

  onCreated(listener: CreatedListener): () => void {
    this.createdListeners.add(listener);
    return () => {
      this.createdListeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const PostStoreContext = createContext<PostStore | null>(null);

/** Um store por sessão: entrar com outra conta não mostra curtidas nem posts da anterior. */
export function PostStoreProvider({
  userId,
  children,
}: {
  userId: string | null;
  children: ReactNode;
}) {
  const store = useMemo(() => new PostStore(userId), [userId]);
  return <PostStoreContext.Provider value={store}>{children}</PostStoreContext.Provider>;
}

export function usePostStore(): PostStore {
  const store = useContext(PostStoreContext);
  if (store === null) {
    throw new Error('usePostStore precisa de um <PostStoreProvider> acima na árvore.');
  }
  return store;
}

/** O post `id` como está agora no store (`undefined` se apagado ou ainda não carregado). */
export function usePost(id: string): Post | undefined {
  const store = usePostStore();
  const getSnapshot = useCallback(() => store.get(id), [store, id]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Só o que já foi publicado (feed e perfil de outra conta: nunca `processing`/`failed`, MID-09). */
export function isPublished(post: Post): boolean {
  return post.status === 'published';
}

/**
 * Filtra ids apagados (re-renderiza quando o store muda) e, com `accept` (estável), os posts que
 * não passam no filtro.
 */
export function useVisibleIds(ids: readonly string[], accept?: (post: Post) => boolean): string[] {
  const store = usePostStore();
  // Uma string estável como snapshot: muda só quando algum id some.
  const getSnapshot = useCallback(
    () =>
      ids
        .filter((postId) => {
          if (store.isDeleted(postId)) return false;
          if (accept === undefined) return true;
          const post = store.get(postId);
          return post !== undefined && accept(post);
        })
        .join('|'),
    [store, ids, accept],
  );
  const joined = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  return joined === '' ? [] : joined.split('|');
}

/** Conexões desfeitas nesta sessão (a lista de conexões tira a linha na hora, 4.9 CA1). */
export function useDisconnectedAuthors(): ReadonlySet<string> {
  const store = usePostStore();
  return useSyncExternalStore(
    store.subscribe,
    store.disconnectedAuthors,
    store.disconnectedAuthors,
  );
}

/** Os @ bloqueados nesta sessão, para filtrar comentários, busca e listas já carregados. */
export function useHiddenAuthors(): ReadonlySet<string> {
  const store = usePostStore();
  return useSyncExternalStore(store.subscribe, store.hiddenAuthors, store.hiddenAuthors);
}
