import type { AccountType } from '@sussurro/shared';
import { EmptyState, theme } from '@sussurro/ui';
import { Redirect, usePathname } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { homeFor, redirectForOtherAccount, ROUTES } from './routes';
import { useAuth } from '../auth/AuthProvider';

export function LoadingScreen() {
  return (
    <View style={styles.center} testID="carregando">
      <ActivityIndicator color={theme.colors.blue} accessibilityLabel="Carregando" />
    </View>
  );
}

/** Havia sessão, mas o servidor não respondeu na abertura do app (sem internet). */
export function UnavailableScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <SafeAreaView style={styles.screen}>
      <EmptyState
        icon="wifi-off"
        title="Não foi possível conectar"
        description="Confira a internet e tente de novo."
        primaryAction={{ label: 'Tentar de novo', onPress: onRetry }}
      />
    </SafeAreaView>
  );
}

/**
 * Portão de sessão (e, opcionalmente, de tipo de conta). Sem sessão vai para "/"; com o tipo
 * errado (deep link para a área do outro tipo), vai para a aba inicial do próprio tipo
 * (história 1.9 CA4). A regra de permissão de verdade está no servidor.
 */
export function RequireSession({
  accountType,
  children,
}: {
  accountType?: AccountType;
  children: ReactNode;
}) {
  const { status, user } = useAuth();
  const pathname = usePathname();
  if (status === 'loading') {
    return <LoadingScreen />;
  }
  if (status !== 'signedIn' || user === null) {
    return <Redirect href="/" />;
  }
  if (accountType !== undefined && user.accountType !== accountType) {
    return <Redirect href={redirectForOtherAccount(pathname, user.accountType)} />;
  }
  return children;
}

/** Telas sem sessão (Entrar, Cadastro…): quem já está logado vai para a própria aba inicial. */
export function RequireSignedOut({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  if (status === 'loading') {
    return <LoadingScreen />;
  }
  if (status === 'signedIn' && user !== null) {
    return <Redirect href={homeFor(user.accountType)} />;
  }
  return children;
}

/** "/": decide para onde ir conforme a sessão. */
export function EntryRedirect() {
  const { status, user, retry } = useAuth();
  if (status === 'loading') {
    return <LoadingScreen />;
  }
  if (status === 'unavailable') {
    return <UnavailableScreen onRetry={retry} />;
  }
  if (status === 'signedOut' || user === null) {
    return <Redirect href={ROUTES.signIn} />;
  }
  return <Redirect href={homeFor(user.accountType)} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.white,
  },
});
