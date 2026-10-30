import { useNetworkState } from 'expo-network';
import { useEffect, useState } from 'react';

/** Só mostra "Sem internet" depois de 2 s sem rede, para não piscar em trocas rápidas (ux.md §5.4). */
export const OFFLINE_DELAY_MS = 2_000;
/** "Conectado" fica 1,5 s na tela e some. */
export const BACK_ONLINE_MS = 1_500;

export type ConnectivityBanner = 'hidden' | 'offline' | 'back';

/** Estado da faixa de conexão a partir do `expo-network`. */
export function useConnectivityBanner(): ConnectivityBanner {
  const network = useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  // "shown": a faixa de offline chegou a aparecer (depois dos 2 s).
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const timer = setTimeout(
      () => {
        setShown(offline);
      },
      offline ? OFFLINE_DELAY_MS : BACK_ONLINE_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [offline]);

  if (!shown) {
    return 'hidden';
  }
  return offline ? 'offline' : 'back';
}
