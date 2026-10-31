import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { issueProximityTokens } from './api';
import { isRepeatableFailure } from './errors';
import { connectClock, connectTiming } from './timing';
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
 * os novos chegarem, então o anúncio e o QR nunca ficam vazios (4.2 CA3).
 *
 * Erros: na renovação, a falha repetível (sem rede, 5xx) tenta de novo a cada `tokenRetryMs` (3 s),
 * até `tokenRetries` (3) vezes, e só então vai para `onError` (ADR 0012, A3-3 item 4); os outros
 * erros, e qualquer erro do 1º pedido da visita (sem tokens ainda), vão na hora. O `onError` para a
 * renovação (a tela decide o estado). `refresh` pede tokens fora do ciclo (ex.: depois de um 409 de
 * "tela fechada"), sem repetir: quem chama decide.
 *
 * Teto (PROX-68): as tentativas zeram a cada sucesso, então, numa rede ruim, a renovação faria até 9
 * emissões em 60 s, e a 7ª levaria o 429 do servidor (6 por minuto): a tela pararia em "Muitas
 * tentativas" (20), o motivo errado. O hook conta as emissões (cada pedido pode ter chegado ao
 * servidor, mesmo sem resposta; o `refresh` também conta) numa janela móvel de 60 s. A tentativa de
 * novo que passaria do teto não sai: vai para `onError` o último erro repetível (18 sem rede, 19
 * indisponível), como no fim das 3 tentativas.
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
  /** O horário de cada emissão dos últimos 60 s, do mais antigo ao mais novo (vale entre visitas). */
  const issuedAtRef = useRef<number[]>([]);

  /** Uma emissão: conta antes de pedir (o pedido pode chegar ao servidor mesmo sem resposta). */
  const issue = useCallback(() => {
    const now = connectClock.now();
    forgetOldIssues(issuedAtRef.current, now);
    issuedAtRef.current.push(now);
    return issueProximityTokens(api);
  }, [api]);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Já houve emissão nesta visita: as seguintes são renovações. */
    let renewing = false;
    /** Tentativas de novo da renovação em curso. */
    let retries = 0;
    /** A última falha repetível da renovação em curso (a próxima ida é uma tentativa de novo). */
    let failure: { error: unknown } | null = null;
    const run = async () => {
      if (failure !== null && !roomForIssue(issuedAtRef.current, connectClock.now())) {
        onErrorRef.current(failure.error);
        return;
      }
      let nextInMs: number;
      try {
        const result = await issue();
        if (cancelled) return;
        renewing = true;
        retries = 0;
        failure = null;
        setTokens({ bleToken: result.bleToken, qrToken: result.qrToken });
        nextInMs = result.renewInS * 1000;
      } catch (error) {
        if (cancelled) return;
        if (!renewing || retries >= connectTiming.tokenRetries || !isRepeatableFailure(error)) {
          onErrorRef.current(error);
          return;
        }
        retries += 1;
        failure = { error };
        nextInMs = connectTiming.tokenRetryMs;
      }
      timer = setTimeout(() => {
        void run();
      }, nextInMs);
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, issue]);

  const refresh = useCallback(async () => {
    const result = await issue();
    setTokens({ bleToken: result.bleToken, qrToken: result.qrToken });
  }, [issue]);

  return { tokens, refresh };
}

/** Esquece as emissões de mais de `tokenIssueWindowMs` (60 s). */
function forgetOldIssues(issuedAt: number[], now: number): void {
  while (issuedAt.length > 0 && now - (issuedAt[0] ?? now) >= connectTiming.tokenIssueWindowMs) {
    issuedAt.shift();
  }
}

/**
 * Cabe mais uma emissão no teto do servidor (PROX-68): no máximo `tokenIssueLimit` (6) em qualquer
 * janela de `tokenIssueWindowMs` (60 s).
 */
function roomForIssue(issuedAt: number[], now: number): boolean {
  forgetOldIssues(issuedAt, now);
  return issuedAt.length < connectTiming.tokenIssueLimit;
}
