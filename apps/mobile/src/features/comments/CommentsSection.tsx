import { COMMENT_MAX_LENGTH, countChars, isBlankText, type Post } from '@sussurro/shared';
import { type CommentThreadView, type CommentView, CommentsSheet } from '@sussurro/ui';
import { router } from 'expo-router';
import { type ReactElement, useMemo } from 'react';

import { type LocalComment, type LocalThread, useComments } from './useComments';
import { useSignedInUser } from '../auth/AuthProvider';
import { EmailNotVerifiedNotice } from '../auth/email-verification';
import { reportHref } from '../moderation/report-target';
import { useBlockAccount } from '../moderation/useBlockAccount';
import type { TabBase } from '../navigation/routes';
import { profileHref } from '../posts/navigation';
import { useHiddenAuthors } from '../posts/post-store';

function toView(comment: LocalComment): CommentView {
  return {
    id: comment.id,
    parentId: comment.parentId,
    author: {
      handle: comment.author.handle,
      name: comment.author.name,
      avatarUri: comment.author.avatarUrl,
      profileVisible: comment.author.profileVisible,
    },
    body: comment.body,
    createdAt: comment.createdAt,
    canDelete: comment.canDelete,
    status: comment.status,
  };
}

function toThreadView(thread: LocalThread): CommentThreadView {
  return { ...toView(thread), replies: thread.replies.map(toView) };
}

/**
 * Tira os comentários das contas bloqueadas nesta sessão (X.2): a conversa inteira quando o
 * comentário de primeiro nível é delas, e as respostas delas nas outras conversas.
 */
function withoutHidden(threads: LocalThread[], hidden: ReadonlySet<string>): LocalThread[] {
  if (hidden.size === 0) return threads;
  return threads
    .filter((thread) => !hidden.has(thread.author.handle))
    .map((thread) => ({
      ...thread,
      replies: thread.replies.filter((reply) => !hidden.has(reply.author.handle)),
    }));
}

/** Mesma regra da API (TXT-04): 1 a 500 code points, sem texto só de invisíveis. */
function validComment(value: string): boolean {
  return !isBlankText(value) && countChars(value) <= COMMENT_MAX_LENGTH;
}

export interface CommentsSectionProps {
  post: Post;
  /** Aba de origem: o @ tocável abre o perfil dentro dela. */
  base: TabBase;
  /** Folha: mostra o título e o ✕; tocar num @ fecha a folha antes de abrir o perfil. */
  onClose?: () => void;
  /** No detalhe: o post acima da lista. */
  listHeader?: ReactElement;
}

/**
 * Comentários de um post ligados à API (2.8). Pessoa comenta e responde em qualquer post que vê;
 * o criador, no próprio post, só responde e apaga (A-06), e em post de outra conta só lê. Nos
 * comentários de outras contas, a pressão longa também tem "Denunciar" e "Bloquear" (D-UX14):
 * bloquear vai pelo comentário (o perfil de quem comentou pode não ser visível).
 */
export function CommentsSection({ post, base, onClose, listHeader }: CommentsSectionProps) {
  const user = useSignedInUser();
  const comments = useComments(post.id);
  const hidden = useHiddenAuthors();
  const block = useBlockAccount();
  const personal = user.accountType === 'personal';
  const threads = useMemo(
    () => withoutHidden(comments.threads, hidden).map(toThreadView),
    [comments.threads, hidden],
  );

  const openAuthor = (handle: string) => {
    const href = profileHref(base, handle, user);
    if (onClose !== undefined) onClose();
    router.push(href);
  };

  return (
    <CommentsSheet
      threads={threads}
      status={comments.status}
      onRetry={() => {
        void comments.reload();
      }}
      hasMore={comments.hasMore}
      loadingMore={comments.loadingMore}
      loadMoreFailed={comments.loadMoreFailed}
      onLoadMore={() => {
        void comments.loadMore();
      }}
      {...(onClose === undefined ? {} : { onClose })}
      {...(listHeader === undefined ? {} : { listHeader })}
      canComment={personal}
      canReply={personal || post.isOwn}
      currentUser={{
        handle: user.handle,
        name: user.name,
        avatarUri: user.avatarUrl,
        seed: user.id,
      }}
      onSubmit={comments.submit}
      onDelete={(comment) => {
        comments.remove(comment.id);
      }}
      onReport={(comment) => {
        router.push(reportHref({ type: 'comment', id: comment.id }));
      }}
      onBlock={(comment) => {
        block({ handle: comment.author.handle, commentId: comment.id });
      }}
      onRetrySend={comments.retrySend}
      onOpenAuthor={openAuthor}
      {...(user.emailVerified ? {} : { composerNotice: <EmailNotVerifiedNotice /> })}
      maxLength={COMMENT_MAX_LENGTH}
      countFn={countChars}
      validate={validComment}
    />
  );
}
