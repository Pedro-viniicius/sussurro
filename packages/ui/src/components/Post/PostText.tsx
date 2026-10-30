import { type AccessibilityActionEvent, Pressable, StyleSheet, View } from 'react-native';

import { HeartButton } from './HeartButton';
import { type PostAuthorView, type PostRelation, RELATION_LABEL } from './types';
import { formatInteger, formatShortTime, spokenShortTime } from '../../format/format';
import { theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Icon } from '../Icon/Icon';
import { IconButton } from '../IconButton/IconButton';
import { Text } from '../Text/Text';

export interface PostTextProps {
  author: PostAuthorView;
  relation: PostRelation;
  /** Até 280 caracteres, mostrado inteiro (sem truncar). */
  text: string;
  publishedAt: string | Date;
  now?: Date;
  likeCount: number;
  liked: boolean;
  commentCount: number;
  /** `false` para o criador (A-06): o coração fica só como indicador do número. */
  canLike?: boolean;
  onLike?: () => void;
  onComment?: () => void;
  /** Abre o detalhe da publicação. */
  onOpen?: () => void;
  onOpenAuthor?: () => void;
  onMore?: () => void;
  testID?: string;
}

const ICON = theme.size.icon.sm;

/**
 * Post de texto na thread (p07, ux.md §6.13): avatar 36, @ + tempo curto, texto inteiro e as ações
 * com o número ao lado (0 também aparece). Hairline entre os itens.
 */
export function PostText({
  author,
  relation,
  text,
  publishedAt,
  now,
  likeCount,
  liked,
  commentCount,
  canLike = true,
  onLike,
  onComment,
  onOpen,
  onOpenAuthor,
  onMore,
  testID = 'post-text',
}: PostTextProps) {
  const relationLabel = RELATION_LABEL[relation];
  const spoken = spokenShortTime(publishedAt, now);

  const actions = [
    ...(onOpen === undefined ? [] : [{ name: 'activate', label: 'Abrir publicação' }]),
    ...(canLike && onLike !== undefined
      ? [{ name: 'like', label: liked ? 'Descurtir' : 'Curtir' }]
      : []),
    ...(onComment === undefined ? [] : [{ name: 'comment', label: 'Comentar' }]),
  ];

  const onAction = (event: AccessibilityActionEvent) => {
    switch (event.nativeEvent.actionName) {
      case 'activate':
        onOpen?.();
        break;
      case 'like':
        onLike?.();
        break;
      case 'comment':
        onComment?.();
        break;
      default:
        break;
    }
  };

  return (
    <View testID={testID} style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Abrir perfil de @${author.handle}`}
        disabled={onOpenAuthor === undefined}
        onPress={onOpenAuthor}
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Avatar
          size={theme.size.avatar.md}
          handle={author.handle}
          {...(author.name === undefined ? {} : { name: author.name })}
          {...(author.seed === undefined ? {} : { seed: author.seed })}
          {...(author.avatarUri === undefined ? {} : { uri: author.avatarUri })}
          decorative
        />
      </Pressable>
      <View style={styles.body}>
        <View style={styles.firstLine}>
          <Text variant="bodyStrong" numberOfLines={1} style={styles.handle}>
            {author.handle}
          </Text>
          <Text variant="caption" color="grey" testID={`${testID}-time`}>
            {formatShortTime(publishedAt, now)}
          </Text>
          <View style={styles.flex} />
          {onMore === undefined ? null : (
            <View style={styles.more}>
              <IconButton
                icon="ellipsis"
                size={ICON}
                color="grey"
                accessibilityLabel="Mais opções"
                onPress={onMore}
              />
            </View>
          )}
        </View>
        <Pressable
          testID={`${testID}-content`}
          accessibilityRole={onOpen === undefined ? 'text' : 'button'}
          accessibilityLabel={`@${author.handle}${relationLabel === null ? '' : `, ${relationLabel}`}, ${spoken}: ${text}`}
          accessibilityActions={actions}
          onAccessibilityAction={onAction}
          disabled={onOpen === undefined}
          onPress={onOpen}
        >
          <Text variant="body">{text}</Text>
        </Pressable>
        <View style={styles.actions}>
          {canLike && onLike !== undefined ? (
            <View style={styles.action}>
              <HeartButton liked={liked} onPress={onLike} size={ICON} testID={`${testID}-like`} />
              <Text variant="bodySm" color="grey" tabularNums testID={`${testID}-likes`}>
                {formatInteger(likeCount)}
              </Text>
            </View>
          ) : (
            <View
              style={styles.action}
              accessible
              accessibilityLabel={`${formatInteger(likeCount)} ${likeCount === 1 ? 'curtida' : 'curtidas'}`}
            >
              <Icon name="heart" size={ICON} color="grey" />
              <Text variant="bodySm" color="grey" tabularNums testID={`${testID}-likes`}>
                {formatInteger(likeCount)}
              </Text>
            </View>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Comentar, ${formatInteger(commentCount)} ${commentCount === 1 ? 'comentário' : 'comentários'}`}
            disabled={onComment === undefined}
            hitSlop={8}
            onPress={onComment}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Icon name="message-circle" size={ICON} />
            <Text variant="bodySm" color="grey" tabularNums testID={`${testID}-comments`}>
              {formatInteger(commentCount)}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: theme.space[12],
    paddingHorizontal: theme.layout.screenX,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.white,
  },
  body: { flex: 1, gap: 2 },
  firstLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  handle: { flexShrink: 1 },
  flex: { flex: 1 },
  more: { marginVertical: -theme.space[12], marginRight: -theme.space[12] },
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space[24], marginTop: 2 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: theme.layout.hitMin,
  },
  pressed: { opacity: theme.opacity.pressed },
});
