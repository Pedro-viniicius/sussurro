import { router } from 'expo-router';
import { useEffect } from 'react';

import { takePendingQrToken } from './pending-qr-link';
import { useAuth } from '../auth/AuthProvider';
import { ROUTES } from '../navigation/routes';

/**
 * Depois de entrar, retoma o deep link do QR guardado sem sessão (se tiver menos de 30 s, 4.7 CA6):
 * a pessoa vai para Conectar com o token; o criador, para o p22.
 */
export function usePendingQrLink(): void {
  const { status, user } = useAuth();
  const accountType = status === 'signedIn' ? user?.accountType : undefined;

  useEffect(() => {
    if (accountType === undefined) return;
    const token = takePendingQrToken();
    if (token === null) return;
    if (accountType === 'creator') {
      router.navigate(ROUTES.creatorConnect);
    } else {
      router.navigate({ pathname: ROUTES.personalConnect, params: { qr: token } });
    }
  }, [accountType]);
}
