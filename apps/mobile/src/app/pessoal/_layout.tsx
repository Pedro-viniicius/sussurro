import { Tabs } from 'expo-router/js-tabs';

import { usePendingQrLink } from '../../features/connect/usePendingQrLink';
import { AppTabBar } from '../../features/navigation/AppTabBar';
import { RequireSession } from '../../features/navigation/guards';

/** Aba inicial ao abrir o grupo. */
export const unstable_settings = { anchor: 'inicio' };

/** Abas da conta pessoal: Início, Pesquisar, Criar, Conectar, Perfil (história 1.9 CA1). */
export default function PersonalLayout() {
  usePendingQrLink();
  return (
    <RequireSession accountType="personal">
      <Tabs
        backBehavior="initialRoute"
        screenOptions={{ headerShown: false }}
        tabBar={(props) => <AppTabBar {...props} variant="personal" />}
      >
        <Tabs.Screen name="inicio" />
        <Tabs.Screen name="pesquisar" />
        <Tabs.Screen name="criar-aba" />
        <Tabs.Screen name="conectar" />
        <Tabs.Screen name="perfil" />
      </Tabs>
    </RequireSession>
  );
}
