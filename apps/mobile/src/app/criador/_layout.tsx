import { Tabs } from 'expo-router/js-tabs';

import { usePendingQrLink } from '../../features/connect/usePendingQrLink';
import { AppTabBar } from '../../features/navigation/AppTabBar';
import { RequireSession } from '../../features/navigation/guards';

/** Aba inicial ao abrir o grupo. */
export const unstable_settings = { anchor: 'perfil' };

/**
 * Abas do criador: Notificações, Criar, Perfil, com Perfil como aba inicial (D-UX17). Início,
 * Pesquisar e Conectar não existem aqui (história 1.9 CA2).
 */
export default function CreatorLayout() {
  usePendingQrLink();
  return (
    <RequireSession accountType="creator">
      <Tabs
        backBehavior="initialRoute"
        screenOptions={{ headerShown: false }}
        tabBar={(props) => <AppTabBar {...props} variant="creator" />}
      >
        <Tabs.Screen name="notificacoes" />
        <Tabs.Screen name="criar-aba" />
        <Tabs.Screen name="perfil" />
        <Tabs.Screen name="conectar" />
      </Tabs>
    </RequireSession>
  );
}
