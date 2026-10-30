import { EmptyState, theme } from '@sussurro/ui';
import { router } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function NotFoundScreen() {
  return (
    <SafeAreaView style={styles.screen}>
      <EmptyState
        icon="circle-alert"
        title="Página não encontrada"
        description="O endereço que você abriu não existe."
        primaryAction={{
          label: 'Voltar ao início',
          onPress: () => {
            router.replace('/');
          },
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
});
