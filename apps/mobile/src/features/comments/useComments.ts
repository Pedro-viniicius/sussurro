import type { Comment, CommentThread } from '@sussurro/shared';
import { useToast } from '@sussurro/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { isApiError } from '../../lib/api/errors';
import { messageForError } from '../../lib/error-messages';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { useEmailNotVerified } from '../auth/email-verification';
import { createComment, deleteComment, fetchComments } from '../posts/api';
import { usePostStore } from '../posts/post-store';
import { isCursorError } from '../posts/usePostPages';

export const DELETE_COMMENT_TITLE = 'Excluir comentário?';

export type SendStatus = 'sent' | 'sending' | 'failed';
export type LocalComment = Comment & { status: SendStatus };
export type LocalThread = LocalComment & { replies: LocalComment[] };

interface CommentsState {
  threads: LocalThread[];
  status: 'loading' | 'error' | 'ready';
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
}

const INITIAL: CommentsState = {
  threads: [],
  status: 'loading',
  hasMore: false,
  loadingMore: false,
  loadMoreFailed: false,
};

function sent(thread: CommentThread): LocalThread {
  return {
    ...thread,
    status: 'sent',
    replies: thread.replies.map((reply) => ({ ...reply, status: 'sent' })),
  };
}

/** Troca um comentário (de primeiro nível ou resposta) pelo resultado de `change`. */
function mapComment(
  threads: LocalThread[],
  commentId: string,
  change: (comment: LocalComment) => LocalComment,
): LocalThread[] {
  return threads.map((thread) =>
    thread.id === commentId
      ? { ...thread, ...change(thread), replies: thread.replies }
      : {
          ...thread,
          replies: thread.replies.map((reply) => (reply.id === commentId ? change(reply) : reply)),
        },
  );
}

function withoutComment(threads: LocalThread[], commentId: string): LocalThread[] {
  return threads
    .filter((thread) => thread.id !== commentId)
    .map((thread) => ({
      ...thread,
      replies: thread.replies.filter((reply) => reply.id !== commentId),
    }));
}

let localSequence = 0;

/**
 * Comentários de um post (história 2.8): primeira página, "ver mais", envio otimista (o item fica a
 * 50% e, na falha, "Não publicado. Tentar de novo"), respostas de 1 nível e exclusão com
 * confirmação. O `commentCount` do post no store acompanha.
 */
export function useComments(postId: string) {
  const { api } = useAuth();
  const user = useSignedInUser();
  const store = usePostStore();
  const toast = useToast();
  const emailNotVerified = useEmailNotVerified();
  const [state, setState] = useState<CommentsState>(INITIAL);
  const cursor = useRef<string | null>(null);

  /** Primeira página; o estado só muda quando a resposta chega. */
  const fetchFirst = useCallback(async () => {
    try {
      const page = await fetchComments(api, postId);
      cursor.current = page.nextCursor;
      setState({
        ...INITIAL,
        status: 'ready',
        threads: page.items.map(sent),
        hasMore: page.nextCursor !== null,
      });
    } catch {
      setState({ ...INITIAL, status: 'error' });
    }
  }, [api, postId]);

  useEffect(() => {
    let active = true;
    // Só a resposta muda o estado (a lista começa em "carregando").
    void Promise.resolve().then(() => (active ? fetchFirst() : undefined));
    return () => {
      active = false;
    };
  }, [fetchFirst]);

  /** "Tentar de novo": volta ao carregando e busca de novo. */
  const loadFirst = useCallback(async () => {
    setState(INITIAL);
    await fetchFirst();
  }, [fetchFirst]);

  const loadMore = useCallback(async () => {
    const next = cursor.current;
    if (next === null || state.loadingMore) return;
    setState((value) => ({ ...value, loadingMore: true, loadMoreFailed: false }));
    try {
      const page = await fetchComments(api, postId, next);
      cursor.current = page.nextCursor;
      setState((value) => {
        const known = new Set(value.threads.map((thread) => thread.id));
        return {
          ...value,
          threads: [
            ...value.threads,
            ...page.items.filter((item) => !known.has(item.id)).map(sent),
          ],
          hasMore: page.nextCursor !== null,
          loadingMore: false,
        };
      });
    } catch (error) {
      if (isCursorError(error)) {
        await loadFirst();
        return;
      }
      setState((value) => ({ ...value, loadingMore: false, loadMoreFailed: true }));
    }
  }, [api, loadFirst, postId, state.loadingMore]);

  const send = useCallback(
    async (localId: string, body: string, parentId: string | null) => {
      try {
        const created = await createComment(api, postId, {
          body,
          ...(parentId === null ? {} : { parentId }),
        });
        setState((value) => ({
          ...value,
          threads: mapComment(value.threads, localId, () => ({ ...created, status: 'sent' })),
        }));
        const post = store.get(postId);
        if (post !== undefined) store.patch(postId, { commentCount: post.commentCount + 1 });
      } catch (error) {
        if (isApiError(error, 'EMAIL_NOT_VERIFIED')) {
          // Não é falha de envio: o comentário sai da lista e aparece o caminho para confirmar.
          setState((value) => ({ ...value, threads: withoutComment(value.threads, localId) }));
          emailNotVerified();
          return;
        }
        setState((value) => ({
          ...value,
          threads: mapComment(value.threads, localId, (comment) => ({
            ...comment,
            status: 'failed',
          })),
        }));
        if (isApiError(error)) toast.show({ message: messageForError(error), variant: 'error' });
      }
    },
    [api, emailNotVerified, postId, store, toast],
  );

  const submit = useCallback(
    (body: string, parentId: string | null) => {
      localSequence += 1;
      const localId = `local-${String(localSequence)}`;
      const local: LocalComment = {
        id: localId,
        parentId,
        body: body.trim(),
        createdAt: new Date().toISOString(),
        author: {
          handle: user.handle,
          name: user.name,
          avatarUrl: user.avatarUrl,
          accountType: user.accountType,
          profileVisible: true,
        },
        canDelete: true,
        status: 'sending',
      };
      setState((value) => ({
        ...value,
        status: 'ready',
        threads:
          parentId === null
            ? [...value.threads, { ...local, replies: [] }]
            : value.threads.map((thread) =>
                thread.id === parentId
                  ? { ...thread, replies: [...thread.replies, local] }
                  : thread,
              ),
      }));
      void send(localId, body, parentId);
    },
    [send, user],
  );

  const retrySend = useCallback(
    (comment: { id: string; body: string; parentId: string | null }) => {
      setState((value) => ({
        ...value,
        threads: mapComment(value.threads, comment.id, (item) => ({ ...item, status: 'sending' })),
      }));
      void send(comment.id, comment.body, comment.parentId);
    },
    [send],
  );

  const remove = useCallback(
    (commentId: string) => {
      const thread = state.threads.find((item) => item.id === commentId);
      const reply = state.threads
        .flatMap((item) => item.replies)
        .find((item) => item.id === commentId);
      const target = thread ?? reply;
      if (target === undefined) return;
      if (target.status !== 'sent') {
        // Nunca chegou ao servidor: só sai da lista.
        setState((value) => ({ ...value, threads: withoutComment(value.threads, commentId) }));
        return;
      }
      Alert.alert(DELETE_COMMENT_TITLE, undefined, [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Excluir',
          style: 'destructive',
          onPress: () => {
            deleteComment(api, commentId)
              .catch((error: unknown) => {
                if (!isApiError(error, 'NOT_FOUND')) throw error;
              })
              .then(() => {
                // Apagar um comentário leva as respostas junto (a API desconta todos).
                const removed =
                  1 + (thread?.replies.filter((item) => item.status === 'sent').length ?? 0);
                setState((value) => ({
                  ...value,
                  threads: withoutComment(value.threads, commentId),
                }));
                const post = store.get(postId);
                if (post !== undefined) {
                  store.patch(postId, { commentCount: Math.max(0, post.commentCount - removed) });
                }
              })
              .catch((error: unknown) => {
                toast.show({ message: messageForError(error), variant: 'error' });
              });
          },
        },
      ]);
    },
    [api, postId, state.threads, store, toast],
  );

  return { ...state, reload: loadFirst, loadMore, submit, retrySend, remove };
}
