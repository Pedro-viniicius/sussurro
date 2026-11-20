import { useRef, useState } from 'react';
import {
  type AccessibilityActionEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { HeartButton } from './HeartButton';
import { PostImage, type PostImageSource } from './PostImage';
import { type PostAuthorView, type PostRelation, RELATION_LABEL } from './types';
import { formatPostTime, likesLabel, viewCommentsLabel } from '../../format/format';
import { theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Icon } from '../Icon/Icon';
import { IconButton } from '../IconButton/IconButton';
import { Text } from '../Text/Text';

export interface PostPhotoProps {
  author: PostAuthorView;
  relation: PostRelation;
  /** 1 a 4 fotos, na ordem da publicação. */
  images: readonly PostImageSource[];
  caption?: string | null;
  likeCount: number;
  liked: boolean;
  commentCount: number;
  publishedAt: string | Date;
  /** Relógio de referência (catálogo e testes); padrão: agora. */
  now?: Date;
  /**
   * `false` para o criador (A-06: criador não curte; o servidor responde 403): o coração não
   * aparece como ação.
   */
  canLike?: boolean;
  onLike?: () => void;
  onOpenComments?: () => void;
  onOpenAuthor?: () => void;
  /**
   * Menu `ellipsis`: "Excluir publicação" nos próprios posts; "Denunciar" e "Bloquear" nos de outras
   * contas (D-UX14).
   */
  onMore?: () => void;
  /** Largura do post; padrão: a largura da tela. */
  width?: number;
  testID?: string;
}

/** Proporção do post de foto (ux.md §6.6): 4:5. */
const ASPECT = 5 / 4;
const ARROW = 28;

/**
 * Post de foto (p06, ux.md §6.13): cabeçalho de 56 com avatar 32, mídia 4:5 com carrossel ("1/3",
 * setas e pontos centralizados), curtir e comentar, "N curtidas", legenda em 2 linhas com "mais",
 * "Ver todos os N comentários" e o tempo relativo.
 */
export function PostPhoto({
  author,
  relation,
  images,
  caption,
  likeCount,
  liked,
  commentCount,
  publishedAt,
  now,
  canLike = true,
  onLike,
  onOpenComments,
  onOpenAuthor,
  onMore,
  width,
  testID = 'post-photo',
}: PostPhotoProps) {
  const window = useWindowDimensions();
  const mediaWidth = width ?? window.width;
  const mediaHeight = Math.round(mediaWidth * ASPECT);
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const count = images.length;
  const multiple = count > 1;
  const relationLabel = RELATION_LABEL[relation];
  const hasCaption = typeof caption === 'string' && caption !== '';

  const goTo = (next: number) => {
    const clamped = Math.max(0, Math.min(count - 1, next));
    setIndex(clamped);
    scrollRef.current?.scrollTo({ x: clamped * mediaWidth, animated: true });
  };

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (mediaWidth > 0) {
      setIndex(Math.round(event.nativeEvent.contentOffset.x / mediaWidth));
    }
  };

  const onCarouselAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'increment') goTo(index + 1);
    if (event.nativeEvent.actionName === 'decrement') goTo(index - 1);
  };

  const mediaLabel = multiple
    ? `Foto ${index + 1} de ${count} de @${author.handle}`
    : `Foto de @${author.handle}`;

  return (
    <View testID={testID} style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Abrir perfil de @${author.handle}${relationLabel === null ? '' : `, ${relationLabel}`}`}
          disabled={onOpenAuthor === undefined}
          onPress={onOpenAuthor}
          style={({ pressed }) => [styles.author, pressed && styles.pressed]}
        >
          <Avatar
            size={theme.size.avatar.sm}
            handle={author.handle}
            {...(author.name === undefined ? {} : { name: author.name })}
            {...(author.seed === undefined ? {} : { seed: author.seed })}
            {...(author.avatarUri === undefined ? {} : { uri: author.avatarUri })}
            decorative
          />
          <View style={styles.flex}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {author.handle}
            </Text>
            {relationLabel === null ? null : (
              <Text variant="caption" color="grey">
                {relationLabel}
              </Text>
            )}
          </View>
        </Pressable>
        {onMore === undefined ? null : (
          <IconButton icon="ellipsis" accessibilityLabel="Mais opções" onPress={onMore} />
        )}
      </View>

      <View
        testID={`${testID}-media`}
        accessible
        accessibilityRole={multiple ? 'adjustable' : 'image'}
        accessibilityLabel={mediaLabel}
        {...(multiple
          ? {
              accessibilityActions: [{ name: 'increment' }, { name: 'decrement' }],
              onAccessibilityAction: onCarouselAction,
            }
          : {})}
        style={{ width: mediaWidth, height: mediaHeight }}
      >
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          scrollEnabled={multiple}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onScrollEnd}
        >
          {images.map((image) => (
            <PostImage key={image.key} source={image} width={mediaWidth} height={mediaHeight} />
          ))}
        </ScrollView>
        {multiple ? (
          <View style={styles.counter} pointerEvents="none">
            <Text variant="micro" color="white" tabularNums testID={`${testID}-counter`}>
              {`${index + 1}/${count}`}
            </Text>
          </View>
        ) : null}
        {multiple && index > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Foto anterior"
            hitSlop={8}
            onPress={() => {
              goTo(index - 1);
            }}
            style={[styles.arrow, styles.arrowLeft, { top: (mediaHeight - ARROW) / 2 }]}
          >
            <Icon name="chevron-left" size={16} />
          </Pressable>
        ) : null}
        {multiple && index < count - 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Próxima foto"
            hitSlop={8}
            onPress={() => {
              goTo(index + 1);
            }}
            style={[styles.arrow, styles.arrowRight, { top: (mediaHeight - ARROW) / 2 }]}
          >
            <Icon name="chevron-right" size={16} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.actions}>
        {canLike && onLike !== undefined ? (
          <HeartButton liked={liked} onPress={onLike} testID={`${testID}-like`} />
        ) : null}
        {onOpenComments === undefined ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Comentar"
            hitSlop={8}
            onPress={onOpenComments}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Icon name="message-circle" />
          </Pressable>
        )}
        {multiple ? (
          <View style={styles.dots} pointerEvents="none" testID={`${testID}-dots`}>
            {images.map((image, i) => (
              <View
                key={image.key}
                style={[
                  styles.dot,
                  { backgroundColor: i === index ? theme.colors.blue : theme.colors.border },
                ]}
              />
            ))}
          </View>
        ) : null}
      </View>

      <View style={styles.texts}>
        {likeCount > 0 ? <Text variant="bodySmStrong">{likesLabel(likeCount)}</Text> : null}
        {hasCaption ? (
          <View>
            <Text
              variant="body"
              testID={`${testID}-caption`}
              {...(expanded ? {} : { numberOfLines: 2 })}
              onTextLayout={(event) => {
                if (!expanded && event.nativeEvent.lines.length > 2) setTruncated(true);
              }}
            >
              <Text variant="bodyStrong">{author.handle}</Text> {caption}
            </Text>
            {truncated && !expanded ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Ver a legenda inteira"
                onPress={() => {
                  setExpanded(true);
                }}
              >
                <Text variant="body" color="grey">
                  mais
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {commentCount > 0 && onOpenComments !== undefined ? (
          <Pressable accessibilityRole="button" onPress={onOpenComments}>
            <Text variant="bodySm" color="grey">
              {viewCommentsLabel(commentCount)}
            </Text>
          </Pressable>
        ) : null}
        <Text variant="caption" color="grey" testID={`${testID}-time`}>
          {formatPostTime(publishedAt, now)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingBottom: theme.space[16], backgroundColor: theme.colors.white },
  header: {
    minHeight: theme.layout.postHeaderHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: theme.layout.screenX,
    paddingRight: theme.space[4],
  },
  author: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  flex: { flex: 1 },
  pressed: { opacity: theme.opacity.pressed },
  counter: {
    position: 'absolute',
    top: theme.space[12],
    right: theme.space[12],
    backgroundColor: theme.colors.mediaChip,
    borderRadius: theme.radius.full,
    paddingVertical: theme.space[4],
    paddingHorizontal: theme.space[8],
  },
  arrow: {
    position: 'absolute',
    width: ARROW,
    height: ARROW,
    borderRadius: ARROW / 2,
    backgroundColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: theme.shadow.sm,
  },
  arrowLeft: { left: theme.space[8] },
  arrowRight: { right: theme.space[8] },
  actions: {
    minHeight: theme.layout.actionsRowHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[16],
    paddingHorizontal: theme.layout.screenX,
  },
  action: { minHeight: theme.layout.hitMin, justifyContent: 'center' },
  dots: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[4],
  },
  dot: {
    width: theme.size.carouselDot,
    height: theme.size.carouselDot,
    borderRadius: theme.size.carouselDot / 2,
  },
  texts: { paddingHorizontal: theme.layout.screenX, gap: theme.space[4] },
});
