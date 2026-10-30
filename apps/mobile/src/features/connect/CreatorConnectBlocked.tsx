import { EmptyState, Text, theme } from '@sussurro/ui';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { COPY } from './copy';
import { ROUTES } from '../navigation/routes';

/**
 * Conectar para o criador (p22, história 4.8 CA2): contas de criador não se conectam. Aparece
 * pelo deep link do QR (`sussurro://c/...`) ou por um link para a aba Conectar da pessoa. As rotas
 * de proximidade também recusam o criador no servidor (403).
 */
export function CreatorConnectBlocked() {
  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="tela-conectar-criador">
      <View style={styles.header}>
        <Text variant="titleLg" accessibilityRole="header">
          {COPY.title}
        </Text>
      </View>
      <EmptyState
        icon="lock"
        title={COPY.creatorTitle}
        description={COPY.creatorText}
        primaryAction={{
          label: COPY.backToProfile,
          onPress: () => {
            router.navigate(ROUTES.creatorProfile);
          },
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  header: {
    minHeight: theme.layout.headerHeight,
    justifyContent: 'center',
    paddingHorizontal: theme.layout.screenX,
  },
});
