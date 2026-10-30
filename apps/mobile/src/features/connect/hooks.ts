import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { issueProximityToken } from './api';
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

/**
 * Meu token de proximidade enquanto a tela Conectar está aberta (ADR 0003): pede um agora e renova
 * a cada `renewInS` (20 s), sem esperar vencer. O token anterior continua valendo até o novo chegar,
 * então o anúncio e o QR nunca ficam vazios (4.2 CA3). Um erro para a renovação e vai para
 * `onError` (a tela decide o estado); `refresh` pede um token fora do ciclo (ex.: depois de um 409
 * de "tela fechada").
 */
export function useProximityToken(
  api: ApiClient,
  active: boolean,
  onError: (error: unknown) => void,
): { token: string | null; refresh: () => Promise<void> } {
  const [token, setToken] = useState<string | null>(null);
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
        const result = await issueProximityToken(api);
        if (cancelled) return;
        setToken(result.token);
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
    const result = await issueProximityToken(api);
    setToken(result.token);
  }, [api]);

  return { token, refresh };
}
