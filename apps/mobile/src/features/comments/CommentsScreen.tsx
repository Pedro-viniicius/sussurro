import { EmptyState, theme } from '@sussurro/ui';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CommentsSection } from './CommentsSection';
import { useSignedInUser } from '../auth/AuthProvider';
import { tabBaseFromQuery } from '../posts/navigation';
import { POST_UNAVAILABLE } from '../posts/PostDetailScreen';
import { usePostLoader } from '../posts/usePostLoader';

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/**
 * Folha de comentários (`comentarios/[postId]`, ux.md §4.3): aberta pelo ícone de comentário ou
 * por "Ver todos os N comentários". `origem` diz a aba em que um @ tocado deve abrir.
 */
export function CommentsScreen() {
  const { postId, origem } = useLocalSearchParams<{ postId: string; origem?: string }>();
  const user = useSignedInUser();
  const base = tabBaseFromQuery(origem, user.accountType);
  const { post, status, reload } = usePostLoader(postId);

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']} testID="tela-comentarios">
      {status === 'notFound' ? (
        <EmptyState
          icon="image-off"
          title={POST_UNAVAILABLE}
          primaryAction={{ label: 'Fechar', onPress: close }}
        />
      ) : status === 'error' ? (
        <EmptyState
          icon="circle-alert"
          title="Não foi possível carregar"
          primaryAction={{ label: 'Tentar de novo', onPress: reload }}
          secondaryAction={{ label: 'Fechar', onPress: close }}
        />
      ) : post === undefined ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.grey} accessibilityLabel="Carregando" />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <CommentsSection post={post} base={base} onClose={close} />
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
