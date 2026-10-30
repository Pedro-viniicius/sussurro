import { OfflineBanner, theme } from '@sussurro/ui';
import { Stack } from 'expo-router';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useConnectivityBanner } from '../../lib/network';
import { useAuth } from '../auth/AuthProvider';
import { PublishingProvider } from '../create/PublishingProvider';
import { NotificationsProvider } from '../notifications/NotificationsProvider';
import { PostStoreProvider } from '../posts/post-store';
import { FollowStoreProvider } from '../relations/follow-store';

/**
 * Folha de comentários (ux.md §6.13): `formSheet` nativa no iOS (70% → 95%). No Android, modal de
 * tela cheia, porque o teclado dentro da `formSheet` ainda não foi validado em aparelho.
 */
const COMMENTS_OPTIONS =
  Platform.OS === 'ios'
    ? {
        presentation: 'formSheet' as const,
        sheetAllowedDetents: [0.7, 0.95],
        sheetGrabberVisible: false,
        sheetCornerRadius: theme.radius.sheet,
      }
    : { presentation: 'modal' as const };

/**
 * Pilha raiz do app (ux.md §3.1). Os portões de sessão e de tipo de conta ficam nos layouts de
 * cada grupo (`(auth)`, `pessoal`, `criador`, `conta`), que redirecionam para a rota certa. Os
 * posts e os follows em memória e as publicações em andamento são por conta: trocam quando a
 * sessão troca. As notificações (ponto azul, push do aparelho e toques nos pushes) também.
 */
export function RootNavigator() {
  const banner = useConnectivityBanner();
  const { user } = useAuth();
  return (
    <PostStoreProvider userId={user?.id ?? null}>
      <FollowStoreProvider userId={user?.id ?? null}>
        <NotificationsProvider>
          <PublishingProvider>
            <View style={styles.root}>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: theme.colors.white },
                }}
              >
                <Stack.Screen name="criar" options={{ presentation: 'fullScreenModal' }} />
                <Stack.Screen name="editar-perfil" options={{ presentation: 'modal' }} />
                <Stack.Screen name="comentarios/[postId]" options={COMMENTS_OPTIONS} />
                <Stack.Screen name="denunciar" options={{ presentation: 'modal' }} />
                <Stack.Screen
                  name="reel/[id]"
                  options={{
                    presentation: 'fullScreenModal',
                    contentStyle: { backgroundColor: theme.colors.black },
                  }}
                />
              </Stack>
              {banner === 'hidden' ? null : (
                <SafeAreaView edges={['top']} pointerEvents="none" style={styles.banner}>
                  <OfflineBanner status={banner} />
                </SafeAreaView>
              )}
            </View>
          </PublishingProvider>
        </NotificationsProvider>
      </FollowStoreProvider>
    </PostStoreProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.white },
  banner: { position: 'absolute', top: 0, left: 0, right: 0 },
});
