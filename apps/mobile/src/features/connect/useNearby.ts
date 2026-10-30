import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { resolveTokens } from './api';
import { COPY } from './copy';
import { isRetryableResolveError } from './errors';
import { NearbyTracker, type NearbyRow } from './nearby';
import { connectClock, connectTiming } from './timing';
import type { ProximityRadio } from '../../../modules/sussurro-proximity';
import type { ApiClient } from '../../lib/api/client';

export interface NearbySnapshot {
  rows: NearbyRow[];
  /** Hora da última atualização (o relógio da lista). */
  at: number;
  /** Última vez que havia alguém na lista (ou o começo da busca). */
  lastVisibleAt: number;
}

export interface UseNearbyOptions {
  api: ApiClient;
  radio: ProximityRadio;
  /** Varrer agora (procurando, ou a folha de um pedido por Bluetooth aberta). */
  scanning: boolean;
  /** Meu token já existe (o `resolve` exige a tela Conectar aberta no servidor). */
  hasOwnToken: boolean;
  /** Erro do `resolve` ou da varredura (a tela decide o estado). */
  onError: (error: unknown) => void;
}

/**
 * "Por perto agora" (4.4): varre enquanto `scanning`, junta os tokens novos e chama o `resolve` em
 * lote no máximo a cada 3 s (A-17), mantém a média do sinal por pessoa e anuncia ao leitor de tela
 * quem entrou na lista (no máximo 1 anúncio a cada 3 s). O RSSI fica no aparelho.
 */
export function useNearby({ api, radio, scanning, hasOwnToken, onError }: UseNearbyOptions) {
  const [tracker] = useState(() => new NearbyTracker());
  const [snapshot, setSnapshot] = useState<NearbySnapshot>(() => ({
    rows: [],
    at: connectClock.now(),
    lastVisibleAt: connectClock.now(),
  }));
  const hasOwnTokenRef = useRef(hasOwnToken);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    hasOwnTokenRef.current = hasOwnToken;
    onErrorRef.current = onError;
  });

  const refreshRows = useCallback(() => {
    const now = connectClock.now();
    const rows = tracker.rows(now, connectTiming.presenceMs);
    setSnapshot((previous) => ({
      rows,
      at: now,
      lastVisibleAt: rows.length > 0 ? now : previous.lastVisibleAt,
    }));
  }, [tracker]);

  useEffect(() => {
    if (!scanning) return undefined;
    let cancelled = false;
    // Função (e não a variável) depois de um `await`: o valor muda na limpeza do efeito.
    const isCancelled = () => cancelled;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let lastCallAt = Number.NEGATIVE_INFINITY;
    let announced = new Set<string>();
    let lastAnnounceAt = Number.NEGATIVE_INFINITY;

    const schedule = () => {
      if (cancelled || timer !== null || inFlight || !tracker.hasPending()) return;
      const wait = Math.max(
        0,
        lastCallAt + connectTiming.resolveMinIntervalMs - connectClock.now(),
      );
      timer = setTimeout(() => {
        timer = null;
        void resolveBatch();
      }, wait);
    };

    const resolveBatch = async () => {
      if (cancelled) return;
      if (!hasOwnTokenRef.current) {
        // Sem a marca de tela aberta o servidor recusaria: espera o token e tenta no próximo ciclo.
        lastCallAt = connectClock.now();
        return;
      }
      const tokens = tracker.takePending();
      if (tokens.length === 0) return;
      inFlight = true;
      lastCallAt = connectClock.now();
      try {
        const result = await resolveTokens(api, tokens);
        if (isCancelled()) return;
        tracker.applyResolve(tokens, result.items);
        refreshRows();
      } catch (error) {
        if (isRetryableResolveError(error)) tracker.release(tokens);
        else tracker.discard(tokens);
        if (!isCancelled()) onErrorRef.current(error);
      } finally {
        inFlight = false;
        schedule();
      }
    };

    const announce = () => {
      const now = connectClock.now();
      const rows = tracker.rows(now, connectTiming.presenceMs);
      const fresh = rows.find((row) => !announced.has(row.handle));
      announced = new Set([...announced, ...rows.map((row) => row.handle)]);
      if (fresh !== undefined && now - lastAnnounceAt >= connectTiming.announceEveryMs) {
        lastAnnounceAt = now;
        AccessibilityInfo.announceForAccessibility(COPY.announceFound(fresh.name));
      }
    };

    const subscription = radio.onSighting(({ token, rssi }) => {
      if (tracker.record(token, rssi, connectClock.now())) schedule();
    });
    radio.startScan().catch((error: unknown) => {
      if (!cancelled) onErrorRef.current(error);
    });
    const ticker = setInterval(() => {
      tracker.prune(connectClock.now());
      refreshRows();
      announce();
      schedule();
    }, connectTiming.tickMs);

    return () => {
      cancelled = true;
      subscription.remove();
      if (timer !== null) clearTimeout(timer);
      clearInterval(ticker);
      radio.stopScan().catch(() => undefined);
    };
  }, [api, radio, refreshRows, scanning, tracker]);

  /** Nova busca: lista vazia e o relógio do "Ninguém por perto" recomeça. */
  const reset = useCallback(() => {
    tracker.clear();
    const now = connectClock.now();
    setSnapshot({ rows: [], at: now, lastVisibleAt: now });
  }, [tracker]);

  const forget = useCallback(
    (handle: string) => {
      tracker.forget(handle);
      refreshRows();
    },
    [refreshRows, tracker],
  );

  const markConnected = useCallback(
    (handle: string) => {
      tracker.markConnected(handle);
      refreshRows();
    },
    [refreshRows, tracker],
  );

  const latestToken = useCallback(
    (handle: string, maxAgeMs: number) => tracker.latestToken(handle, connectClock.now(), maxAgeMs),
    [tracker],
  );

  const isPresent = useCallback(
    (handle: string, withinMs: number) => tracker.isPresent(handle, connectClock.now(), withinMs),
    [tracker],
  );

  return { snapshot, reset, forget, markConnected, latestToken, isPresent };
}
