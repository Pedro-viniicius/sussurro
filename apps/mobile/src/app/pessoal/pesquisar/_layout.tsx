import { Stack } from 'expo-router';

/** Pilha da aba: a busca e, por cima, o perfil do criador (p17, com Pesquisar ativo) e o post. */
export const unstable_settings = { anchor: 'index' };

export default function TabStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
