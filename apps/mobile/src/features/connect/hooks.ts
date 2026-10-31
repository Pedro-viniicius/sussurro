import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { issueProximityTokens } from './api';
import type { ApiClient } from '../../lib/api/client';

/**
 * `false` com o app em background. O "inactive" do iOS (alerta do sistema, central de controle)
 * conta como ativo: só o background para a tela Conectar.
 */
export function useAppActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState !== 'background');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setActive(next !== 'background');
    });
    return () => {
      subscription.remove();
    };
  }, []);

  return active;
}

/**
 * Roda `task` agora e de novo `intervalMs` depois de cada fim, enquanto `active` (sem chamadas
 * sobrepostas). Erros ficam com a própria tarefa.
 */
export function usePolling(task: () => Promise<void>, intervalMs: number, active: boolean): void {
  const taskRef = useRef(task);
  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        await taskRef.current();
      } catch {
        // A tarefa trata (ou ignora) os próprios erros; o polling continua.
      }
      if (!cancelled) {
        timer = setTimeout(() => {
          void run();
        }, intervalMs);
      }
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, intervalMs]);
}

/** Os dois tokens da emissão em vigor (ADR 0012 §1). */
export interface OwnTokens {
  /** Só vai no anúncio Bluetooth (UUID de serviço). */
  bleToken: string;
  /** Só aparece no QR (`sussurro://c/{qrToken}`). */
  qrToken: string;
}

/**
 * Meus tokens de proximidade enquanto a tela Conectar está aberta (ADR 0003 e 0012): pede agora e
 * renova a cada `renewInS` (20 s), sem esperar vencer. Os tokens anteriores continuam valendo até
 * os novos chegarem, então o anúncio e o QR nunca ficam vazios (4.2 CA3). Um erro para a renovação
 * e vai para `onError` (a tela decide o estado); `refresh` pede tokens fora do ciclo (ex.: depois
 * de um 409 de "tela fechada").
 */
export function useProximityToken(
  api: ApiClient,
  active: boolean,
  onError: (error: unknown) => void,
): { tokens: OwnTokens | null; refresh: () => Promise<void> } {
  const [tokens, setTokens] = useState<OwnTokens | null>(null);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const result = await issueProximityTokens(api);
        if (cancelled) return;
        setTokens({ bleToken: result.bleToken, qrToken: result.qrToken });
        timer = setTimeout(() => {
          void run();
        }, result.renewInS * 1000);
      } catch (error) {
        if (!cancelled) onErrorRef.current(error);
      }
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, api]);

  const refresh = useCallback(async () => {
    const result = await issueProximityTokens(api);
    setTokens({ bleToken: result.bleToken, qrToken: result.qrToken });
  }, [api]);

  return { tokens, refresh };
}
