import { EmptyState, PostSkeleton, ScreenHeader, theme } from '@sussurro/ui';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { reelHref, useTabBase } from './navigation';
import { PostCard } from './PostCard';
import { usePostLoader } from './usePostLoader';
import { useSignedInUser } from '../auth/AuthProvider';
import { CommentsSection } from '../comments/CommentsSection';

export const POST_UNAVAILABLE = 'Esta publicação não está mais disponível.';

function back() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/**
 * Detalhe da publicação (`p/[id]`, ux.md §4.2): o mesmo post do feed com os comentários abaixo e o
 * campo fixo acima do teclado. Apagado ou sem acesso (404): "Esta publicação não está mais
 * disponível." Um reel (ex.: link ou notificação antiga) abre no visualizador (5.5), que toma o
 * lugar do detalhe: fechar volta para onde a pessoa estava.
 */
export function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const user = useSignedInUser();
  const base = useTabBase(user.accountType);
  const { post, status, reload } = usePostLoader(id);
  const reel = post?.type === 'reel';

  useEffect(() => {
    if (status === 'ready' && reel) router.replace(reelHref(id, base));
  }, [base, id, reel, status]);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="tela-publicacao">
      <ScreenHeader variant="back" title="Publicação" onBack={back} />
      {status === 'notFound' ? (
        <EmptyState
          icon="image-off"
          title={POST_UNAVAILABLE}
          primaryAction={{ label: 'Voltar', onPress: back }}
          testID="publicacao-indisponivel"
        />
      ) : status === 'error' ? (
        <EmptyState
          icon="circle-alert"
          title="Não foi possível carregar"
          primaryAction={{ label: 'Tentar de novo', onPress: reload }}
        />
      ) : status === 'loading' || post === undefined || reel ? (
        <PostSkeleton kind="photo" testID="publicacao-carregando" />
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <CommentsSection
            post={post}
            base={base}
            listHeader={<PostCard postId={post.id} base={base} inDetail onDeleted={back} />}
          />
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  flex: { flex: 1 },
});
