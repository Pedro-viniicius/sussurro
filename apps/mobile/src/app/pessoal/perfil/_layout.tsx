import { Stack } from 'expo-router';

/** Pilha da aba: a tela inicial e, por cima, o detalhe do post e o perfil de outra conta. */
export const unstable_settings = { anchor: 'index' };

export default function TabStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
