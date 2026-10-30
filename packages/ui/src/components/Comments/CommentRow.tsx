import { type AccessibilityActionEvent, Pressable, StyleSheet, View } from 'react-native';

import type { CommentView } from './types';
import { formatShortTime, spokenShortTime } from '../../format/format';
import { theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Text } from '../Text/Text';

export interface CommentRowProps {
  comment: CommentView;
  now?: Date;
  /** "Responder" visível e na lista de ações. */
  canReply: boolean;
  onReply: (comment: CommentView) => void;
  onDelete: (comment: CommentView) => void;
  /** "Denunciar" (X.1): só chega em comentários de outras contas. */
  onReport?: (comment: CommentView) => void;
  /** "Bloquear" (X.2): só chega em comentários de outras contas. */
  onBlock?: (comment: CommentView) => void;
  /** Pressão longa: menu com as ações disponíveis (ux.md §4.3). */
  onLongPress: (comment: CommentView) => void;
  /** Só é chamado quando `author.profileVisible` (D11). */
  onOpenAuthor?: (handle: string) => void;
  onRetry?: (comment: CommentView) => void;
  testID?: string;
}

/** Linha de comentário (ux.md §4.3): avatar 32, @ 14/600 · tempo, texto 14/20, "Responder". */
export function CommentRow({
  comment,
  now,
  canReply,
  onReply,
  onDelete,
  onReport,
  onBlock,
  onLongPress,
  onOpenAuthor,
  onRetry,
  testID = `comment-${comment.id}`,
}: CommentRowProps) {
  const { author } = comment;
  const isReply = comment.parentId !== null;
  const sending = comment.status === 'sending';
  const failed = comment.status === 'failed';
  const authorTappable = author.profileVisible && onOpenAuthor !== undefined;

  const actions = [
    ...(canReply && !failed && !sending ? [{ name: 'reply', label: 'Responder' }] : []),
    ...(comment.canDelete && !sending ? [{ name: 'delete', label: 'Excluir' }] : []),
    ...(onReport !== undefined ? [{ name: 'report', label: 'Denunciar' }] : []),
    ...(onBlock !== undefined ? [{ name: 'block', label: 'Bloquear' }] : []),
  ];
  // O item é um elemento só para o leitor de tela: o @ tocável vira uma ação também.
  const a11yActions = authorTappable
    ? [...actions, { name: 'author', label: `Abrir perfil de @${author.handle}` }]
    : actions;

  const onAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'reply') onReply(comment);
    if (event.nativeEvent.actionName === 'delete') onDelete(comment);
    if (event.nativeEvent.actionName === 'report') onReport?.(comment);
    if (event.nativeEvent.actionName === 'block') onBlock?.(comment);
    if (event.nativeEvent.actionName === 'author' && authorTappable) onOpenAuthor(author.handle);
  };

  return (
    <Pressable
      testID={testID}
      accessibilityLabel={`@${author.handle}, ${spokenShortTime(comment.createdAt, now)}: ${comment.body}`}
      accessibilityActions={a11yActions}
      onAccessibilityAction={onAction}
      onLongPress={
        actions.length === 0
          ? undefined
          : () => {
              onLongPress(comment);
            }
      }
      style={[styles.row, isReply && styles.reply, sending && styles.sending]}
    >
      <Avatar
        size={theme.size.avatar.sm}
        handle={author.handle}
        {...(author.name === undefined ? {} : { name: author.name })}
        {...(author.avatarUri === undefined ? {} : { uri: author.avatarUri })}
        decorative
      />
      <View style={styles.body}>
        <View style={styles.firstLine}>
          {authorTappable ? (
            <Pressable
              testID={`${testID}-author`}
              accessibilityRole="link"
              accessibilityLabel={`Perfil de @${author.handle}`}
              hitSlop={8}
              onPress={() => {
                onOpenAuthor(author.handle);
              }}
            >
              <Text variant="bodySmStrong">{author.handle}</Text>
            </Pressable>
          ) : (
            <Text variant="bodySmStrong" testID={`${testID}-author-text`}>
              {author.handle}
            </Text>
          )}
          <Text variant="caption" color="grey">
            · {formatShortTime(comment.createdAt, now)}
          </Text>
        </View>
        <Text variant="bodySm">{comment.body}</Text>
        {failed ? (
          <View style={styles.footer}>
            <Text variant="caption" color="danger">
              Não publicado.
            </Text>
            {onRetry === undefined ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Tentar de novo"
                hitSlop={8}
                onPress={() => {
                  onRetry(comment);
                }}
              >
                <Text variant="caption" color="blue" style={styles.strong}>
                  Tentar de novo
                </Text>
              </Pressable>
            )}
          </View>
        ) : canReply && !sending ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Responder a @${author.handle}`}
            hitSlop={8}
            onPress={() => {
              onReply(comment);
            }}
            style={styles.footer}
          >
            <Text variant="caption" color="grey" style={styles.strong}>
              Responder
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: theme.space[12],
    paddingHorizontal: theme.layout.screenX,
    paddingVertical: theme.space[8],
  },
  reply: { paddingLeft: theme.layout.screenX + 44 },
  sending: { opacity: 0.5 },
  body: { flex: 1, gap: 2 },
  firstLine: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  footer: { flexDirection: 'row', gap: theme.space[8], paddingTop: 2 },
  strong: { fontFamily: theme.fonts.semibold },
});
