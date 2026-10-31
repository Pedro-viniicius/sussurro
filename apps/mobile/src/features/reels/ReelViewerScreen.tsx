import {
  Button,
  Icon,
  IconButton,
  ReelViewer,
  type ReelViewerStatus,
  Text,
  theme,
} from '@sussurro/ui';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { videoOf } from './ReelGridTile';
import { useSignedInUser } from '../auth/AuthProvider';
import { useModerationMenu } from '../moderation/useModerationMenu';
import { homeFor, type HomeRoute } from '../navigation/routes';
import { commentsHref, profileHref, tabBaseFromQuery } from '../posts/navigation';
import { relationOf } from '../posts/PostCard';
import { POST_UNAVAILABLE } from '../posts/PostDetailScreen';
import { useDeletePost } from '../posts/useDeletePost';
import { useLike } from '../posts/useLike';
import { usePostLoader } from '../posts/usePostLoader';

function close(fallback: HomeRoute) {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

/** Tela preta com uma mensagem (indisponível ou erro); o ✕ fica no topo. */
function Message({
  title,
  onRetry,
  testID,
}: {
  title: string;
  onRetry?: () => void;
  testID: string;
}) {
  return (
    <View style={styles.message} testID={testID}>
      <Icon name="circle-alert" size={theme.size.icon.lg} color="white" />
      <Text variant="bodyStrong" color="white" align="center" accessibilityRole="header">
        {title}
      </Text>
      {onRetry === undefined ? null : (
        <Button variant="secondary" size="sm" label="Tentar de novo" onPress={onRetry} />
      )}
    </View>
  );
}

/**
 * Visualizador de um reel (`reel/[id]`, `fullScreenModal` preto, ux.md §4.4): abre um reel só e
 * nunca passa para outro (D-UX7, 5.5 CA1). Curtir e comentar como nos posts; o ⋯ tem "Excluir" nos
 * próprios e "Denunciar"/"Bloquear" nos de outras contas. Um reel que não está publicado só abre
 * para o autor (o servidor já responde 404 para os outros, MID-09; o app confere de novo).
 */
export function ReelViewerScreen() {
  const { id, origem } = useLocalSearchParams<{ id: string; origem?: string }>();
  const user = useSignedInUser();
  const base = tabBaseFromQuery(origem, user.accountType);
  const { post, status, reload } = usePostLoader(id);
  const like = useLike();
  const confirmDelete = useDeletePost();
  const menu = useModerationMenu();
  const focused = useIsFocused();
  const fallback = homeFor(user.accountType);
  const onClose = useCallback(() => {
    close(fallback);
  }, [fallback]);

  const video = post === undefined ? undefined : videoOf(post);
  const unavailable =
    status === 'notFound' ||
    (post !== undefined && (post.type !== 'reel' || (!post.isOwn && post.status !== 'published')));

  let content;
  if (unavailable) {
    content = <Message title={POST_UNAVAILABLE} testID="reel-indisponivel" />;
  } else if (status === 'error') {
    content = <Message title="Não foi possível carregar" onRetry={reload} testID="reel-erro" />;
  } else if (post === undefined || video === undefined) {
    content = (
      <View style={styles.message}>
        <ActivityIndicator color={theme.colors.white} accessibilityLabel="Carregando" />
      </View>
    );
  } else {
    const viewerStatus: ReelViewerStatus =
      post.status === 'published' && video.status === 'ready'
        ? 'ready'
        : post.status === 'failed'
          ? 'failed'
          : 'processing';
    const landscape = video.width !== null && video.height !== null && video.width > video.height;
    content = (
      <ReelViewer
        source={{ key: video.id, uri: video.url, posterUri: video.thumbUrl }}
        status={viewerStatus}
        author={{
          handle: post.author.handle,
          name: post.author.name,
          avatarUri: post.author.avatarUrl,
        }}
        relation={relationOf(post)}
        caption={post.caption}
        likeCount={post.likeCount}
        liked={post.likedByMe}
        commentCount={post.commentCount}
        // Criador não curte (A-06).
        canLike={user.accountType === 'personal'}
        active={focused}
        contentFit={landscape ? 'contain' : 'cover'}
        onClose={onClose}
        onLike={() => {
          void like(post.id);
        }}
        onOpenComments={() => {
          router.push(commentsHref(post.id, base));
        }}
        onOpenAuthor={() => {
          const href = profileHref(base, post.author.handle, user);
          onClose();
          router.push(href);
        }}
        onMore={
          post.isOwn
            ? () => {
                confirmDelete(post.id, onClose);
              }
            : () => {
                menu.open({ type: 'post', id: post.id, handle: post.author.handle }, onClose);
              }
        }
        // A URL assinada pode ter vencido (6 h, A-19): busca o post de novo.
        onRetry={reload}
        testID="reel-viewer"
      />
    );
  }

  const showsViewer =
    !unavailable && status !== 'error' && post !== undefined && video !== undefined;
  return (
    <View style={styles.screen} testID="tela-reel">
      <StatusBar style="light" />
      {showsViewer ? (
        content
      ) : (
        <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
          <View style={styles.top}>
            <IconButton icon="x" color="white" accessibilityLabel="Fechar" onPress={onClose} />
          </View>
          {content}
        </SafeAreaView>
      )}
      {menu.element}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.black },
  top: { flexDirection: 'row', paddingHorizontal: theme.space[4] },
  message: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[12],
    paddingHorizontal: theme.space[32],
  },
});
