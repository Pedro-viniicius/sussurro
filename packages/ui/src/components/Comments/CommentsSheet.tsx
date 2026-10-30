import { type ReactElement, type ReactNode, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';

import { CommentComposer, type CommentComposerHandle } from './CommentComposer';
import { CommentRow } from './CommentRow';
import type { CommentThreadView, CommentView, ComposerUser } from './types';
import { theme } from '../../theme';
import { type ActionSheetAction, useActionSheet } from '../ActionSheet/ActionSheet';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import { CommentSkeleton } from '../Skeleton/Skeleton';
import { Text } from '../Text/Text';

export type CommentsStatus = 'loading' | 'error' | 'ready';

export interface CommentsSheetProps {
  threads: readonly CommentThreadView[];
  status: CommentsStatus;
  /** Recarrega a lista depois de um erro. */
  onRetry: () => void;
  hasMore: boolean;
  loadingMore?: boolean;
  loadMoreFailed?: boolean;
  onLoadMore: () => void;
  /** Modo folha: grabber, título "Comentários" e ✕ (alternativa ao arrasto, WCAG 2.5.7). */
  onClose?: () => void;
  /** Conteúdo acima da lista (o post, no detalhe). */
  listHeader?: ReactElement | null;
  /** Campo de comentário de primeiro nível (o criador não tem, A-06). */
  canComment: boolean;
  /** "Responder" nos comentários. */
  canReply: boolean;
  currentUser: ComposerUser;
  onSubmit: (body: string, parentId: string | null) => void;
  /** "Excluir" (o app confirma antes de apagar). */
  onDelete: (comment: CommentView) => void;
  /** "Denunciar" (X.1), só em comentários de outras contas. */
  onReport?: (comment: CommentView) => void;
  /** "Bloquear" (X.2), só em comentários de outras contas; vem depois de "Denunciar". */
  onBlock?: (comment: CommentView) => void;
  onRetrySend?: (comment: CommentView) => void;
  /** Só chega para autores com `profileVisible` (D11). */
  onOpenAuthor?: (handle: string) => void;
  composerNotice?: ReactNode;
  maxLength: number;
  countFn?: (value: string) => number;
  validate?: (value: string) => boolean;
  now?: Date;
  testID?: string;
}

interface ReplyTarget {
  parentId: string;
  handle: string;
}

/**
 * Comentários (ux.md §4.3 e §6.13): lista com respostas recuadas (1 nível), "Responder", ações por
 * pressão longa ("Responder", "Excluir" e, nos comentários de outras contas, "Denunciar" e
 * "Bloquear", D-UX14) e o campo fixo embaixo. Serve à folha
 * (`comentarios/[postId]`) e ao detalhe do post (`p/[id]`), que passa o post em `listHeader`.
 */
export function CommentsSheet({
  threads,
  status,
  onRetry,
  hasMore,
  loadingMore = false,
  loadMoreFailed = false,
  onLoadMore,
  onClose,
  listHeader,
  canComment,
  canReply,
  currentUser,
  onSubmit,
  onDelete,
  onReport,
  onBlock,
  onRetrySend,
  onOpenAuthor,
  composerNotice,
  maxLength,
  countFn,
  validate,
  now,
  testID = 'comments',
}: CommentsSheetProps) {
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const composer = useRef<CommentComposerHandle>(null);
  const menu = useActionSheet(`${testID}-menu`);
  const rows = useMemo(
    () => threads.flatMap((thread): CommentView[] => [thread, ...thread.replies]),
    [threads],
  );

  const startReply = (comment: CommentView) => {
    // Resposta de resposta não existe (2.8 CA2): responde na mesma conversa.
    setReplyTo({ parentId: comment.parentId ?? comment.id, handle: comment.author.handle });
    setTimeout(() => composer.current?.focus(), 0);
  };

  /** Denunciar e bloquear só valem para comentários já publicados de outras contas. */
  const isOthers = (comment: CommentView) =>
    comment.author.handle !== currentUser.handle &&
    (comment.status === undefined || comment.status === 'sent');

  const showActions = (comment: CommentView) => {
    const sent = comment.status === undefined || comment.status === 'sent';
    const others = isOthers(comment);
    const actions: ActionSheetAction[] = [
      ...(canReply && sent
        ? [
            {
              label: 'Responder',
              onPress: () => {
                startReply(comment);
              },
            },
          ]
        : []),
      ...(comment.canDelete
        ? [
            {
              label: 'Excluir',
              destructive: true,
              onPress: () => {
                onDelete(comment);
              },
            },
          ]
        : []),
      ...(others && onReport !== undefined
        ? [
            {
              label: 'Denunciar',
              onPress: () => {
                onReport(comment);
              },
            },
          ]
        : []),
      ...(others && onBlock !== undefined
        ? [
            {
              label: 'Bloquear',
              destructive: true,
              onPress: () => {
                onBlock(comment);
              },
            },
          ]
        : []),
    ];
    menu.show({ title: `Comentário de @${comment.author.handle}`, actions });
  };

  const showComposer = canComment || replyTo !== null;

  const empty =
    status === 'loading' ? (
      <View testID={`${testID}-loading`}>
        <CommentSkeleton />
        <CommentSkeleton />
        <CommentSkeleton />
      </View>
    ) : status === 'error' ? (
      <View style={styles.message} testID={`${testID}-error`}>
        <Text variant="bodySm" color="grey" align="center">
          Não foi possível carregar os comentários.
        </Text>
        <Button variant="secondary" size="sm" label="Tentar de novo" onPress={onRetry} />
      </View>
    ) : (
      <View style={styles.message} testID={`${testID}-empty`}>
        <Text variant="bodySm" color="grey" align="center">
          Ainda não há comentários. Comece a conversa.
        </Text>
      </View>
    );

  const footer = loadingMore ? (
    <ActivityIndicator style={styles.footer} color={theme.colors.grey} />
  ) : loadMoreFailed ? (
    <View style={[styles.footer, styles.footerRow]}>
      <Text variant="bodySm" color="grey">
        Não carregou.
      </Text>
      <Button variant="link" size="sm" label="Tentar de novo" onPress={onLoadMore} />
    </View>
  ) : hasMore ? (
    <View style={styles.footer}>
      <Button variant="link" size="sm" label="Ver mais comentários" onPress={onLoadMore} />
    </View>
  ) : null;

  return (
    <View
      testID={testID}
      style={styles.container}
      {...(onClose === undefined ? {} : { accessibilityViewIsModal: true })}
    >
      {onClose === undefined ? null : (
        <View style={styles.sheetHeader}>
          <View style={styles.grabber} />
          <View style={styles.titleRow}>
            <View style={styles.side} />
            <Text variant="titleSm" align="center" accessibilityRole="header" style={styles.title}>
              Comentários
            </Text>
            <View style={styles.side}>
              <IconButton icon="x" accessibilityLabel="Fechar" onPress={onClose} />
            </View>
          </View>
        </View>
      )}
      <FlatList
        style={styles.list}
        data={status === 'ready' ? rows : []}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={listHeader ?? undefined}
        ListEmptyComponent={empty}
        ListFooterComponent={footer ?? undefined}
        renderItem={({ item }) => (
          <CommentRow
            comment={item}
            {...(now === undefined ? {} : { now })}
            canReply={canReply}
            onReply={startReply}
            onDelete={onDelete}
            {...(onReport !== undefined && isOthers(item) ? { onReport } : {})}
            {...(onBlock !== undefined && isOthers(item) ? { onBlock } : {})}
            onLongPress={showActions}
            {...(onOpenAuthor === undefined ? {} : { onOpenAuthor })}
            {...(onRetrySend === undefined ? {} : { onRetry: onRetrySend })}
          />
        )}
      />
      {showComposer ? (
        <CommentComposer
          ref={composer}
          user={currentUser}
          replyingTo={replyTo?.handle ?? null}
          onCancelReply={() => {
            setReplyTo(null);
          }}
          onSubmit={(body) => {
            onSubmit(body, replyTo?.parentId ?? null);
            setReplyTo(null);
          }}
          maxLength={maxLength}
          {...(countFn === undefined ? {} : { countFn })}
          {...(validate === undefined ? {} : { validate })}
          {...(composerNotice === undefined ? {} : { notice: composerNotice })}
        />
      ) : null}
      {menu.element}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.white },
  sheetHeader: {
    paddingTop: theme.space[8],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.colors.border,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: theme.space[4] },
  side: { width: theme.layout.hitMin, alignItems: 'center' },
  title: { flex: 1 },
  list: { flex: 1 },
  message: {
    alignItems: 'center',
    gap: theme.space[12],
    paddingVertical: theme.space[32],
    paddingHorizontal: theme.layout.screenX,
  },
  footer: { paddingVertical: theme.space[16], alignItems: 'center' },
  footerRow: { flexDirection: 'row', justifyContent: 'center', gap: theme.space[8] },
});
