import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { savePendingQrToken } from './pending-qr-link';
import { useAuth } from '../auth/AuthProvider';
import { LoadingScreen } from '../navigation/guards';
import { ROUTES } from '../navigation/routes';

/**
 * `sussurro://c/{token}` (a câmera do sistema leu um QR do Sussurro, 4.7 CA6):
 * - pessoa logada: aba Conectar com o token, que inicia o fluxo QR;
 * - criador: Conectar bloqueado (p22, 4.8 CA2);
 * - sem sessão: guarda o token só em memória e pede para entrar; depois de 30 s ele é descartado.
 */
export function QrLinkRoute() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { status, user } = useAuth();
  const value = typeof token === 'string' ? token : '';
  const signedOut = status === 'signedOut' || status === 'unavailable';

  useEffect(() => {
    if (!signedOut) return;
    if (value !== '') savePendingQrToken(value);
    router.replace(ROUTES.signIn);
  }, [signedOut, value]);

  if (status === 'signedIn' && user !== null) {
    if (user.accountType === 'creator') return <Redirect href={ROUTES.creatorConnect} />;
    return <Redirect href={{ pathname: ROUTES.personalConnect, params: { qr: value } }} />;
  }
  return <LoadingScreen />;
}
