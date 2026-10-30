import { Redirect, Stack } from 'expo-router';

import { isDevRoutesEnabled } from '../../lib/dev-routes';

/**
 * Portão das rotas `/dev/*`: fora de desenvolvimento (e sem `EXPO_PUBLIC_DEV_TOOLS=1`)
 * qualquer rota daqui redireciona para o início (ux.md §6.15, CA10 da história 0.8).
 */
export default function DevLayout() {
  if (!isDevRoutesEnabled()) {
    return <Redirect href="/" />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
