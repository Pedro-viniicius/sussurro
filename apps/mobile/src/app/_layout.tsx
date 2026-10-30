import { theme, ToastProvider } from '@sussurro/ui';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { AuthProvider } from '../features/auth/AuthProvider';
import { RootNavigator } from '../features/navigation/RootNavigator';
import { apiClient } from '../lib/api/config';
import { useAppFonts } from '../lib/fonts';
import { configureNativePush } from '../lib/push/native-push';
import { initSentry } from '../lib/sentry';
import { secureSessionStore } from '../lib/session/secure-session-store';

// Sentry só com DSN (decisão D4). Antes de qualquer tela, para capturar erros de render.
initSentry();

// Push com o app aberto: banner sem som (6.5). Antes de qualquer tela.
configureNativePush();

// Segura o splash até as fontes carregarem (sem "flash" de fonte do sistema).
SplashScreen.preventAutoHideAsync().catch(() => undefined);
SplashScreen.setOptions({ duration: theme.motion.base, fade: true });

export default function RootLayout() {
  const [loaded, error] = useAppFonts();

  useEffect(() => {
    if (loaded || error !== null) {
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [loaded, error]);

  if (!loaded && error === null) {
    return null;
  }

  return (
    <ToastProvider>
      <StatusBar style="dark" />
      <AuthProvider api={apiClient} store={secureSessionStore}>
        <RootNavigator />
      </AuthProvider>
    </ToastProvider>
  );
}
