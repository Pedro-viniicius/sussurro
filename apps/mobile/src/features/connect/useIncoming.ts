import type { ConnectionRequest } from '@sussurro/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchIncomingRequests } from './api';
import { usePolling } from './hooks';
import { connectClock, connectTiming } from './timing';
import type { ApiClient } from '../../lib/api/client';

export interface IncomingEntry {
  request: ConnectionRequest;
  /** Fim do prazo no relógio do aparelho, a partir do `expiresInS` do servidor. */
  deadline: number;
}

interface QueueState {
  entries: IncomingEntry[];
  dismissed: ReadonlySet<string>;
  now: number;
}

function headOf(value: QueueState): IncomingEntry | null {
  return value.entries.find((entry) => !value.dismissed.has(entry.request.id)) ?? null;
}

/**
 * Pedidos recebidos (4.6): polling de 2 s com a tela aberta, do mais antigo ao mais novo, e uma
 * folha por vez (4.6 CA10). O prazo da folha conta pelo `expiresInS` (relógio do servidor). Quando
 * o pedido da folha some (venceu ou foi cancelado), `onHeadGone` avisa para o Toast.
 */
export function useIncoming(
  api: ApiClient,
  active: boolean,
  onHeadGone: (entry: IncomingEntry, expired: boolean) => void,
) {
  const [state, setState] = useState<QueueState>(() => ({
    entries: [],
    dismissed: new Set(),
    now: connectClock.now(),
  }));
  const stateRef = useRef(state);
  const onHeadGoneRef = useRef(onHeadGone);
  useEffect(() => {
    stateRef.current = state;
    onHeadGoneRef.current = onHeadGone;
  });

  usePolling(
    async () => {
      const result = await fetchIncomingRequests(api);
      const now = connectClock.now();
      const previous = stateRef.current;
      const head = headOf(previous);
      const known = new Map(previous.entries.map((entry) => [entry.request.id, entry]));
      const entries = result.items
        .filter((request) => request.status === 'pending')
        .map((request) => {
          const deadline = now + request.expiresInS * 1000;
          const before = known.get(request.id);
          return {
            request,
            deadline: before === undefined ? deadline : Math.min(before.deadline, deadline),
          };
        });
      const next = { ...previous, entries, now };
      stateRef.current = next;
      setState(next);
      if (head !== null && !entries.some((entry) => entry.request.id === head.request.id)) {
        onHeadGoneRef.current(head, head.deadline <= now);
      }
    },
    connectTiming.pollMs,
    active,
  );

  // Relógio da contagem "Expira em 1:45"; a folha fecha sozinha no fim do prazo.
  const hasEntries = state.entries.length > 0;
  useEffect(() => {
    if (!active || !hasEntries) return undefined;
    const ticker = setInterval(() => {
      const now = connectClock.now();
      const previous = stateRef.current;
      const head = headOf(previous);
      const expired = head !== null && head.deadline <= now;
      // Vencido aqui não volta, mesmo que um polling atrasado ainda o traga.
      const next: QueueState = expired
        ? {
            now,
            entries: previous.entries.filter((entry) => entry.request.id !== head.request.id),
            dismissed: new Set([...previous.dismissed, head.request.id]),
          }
        : { ...previous, now };
      stateRef.current = next;
      setState(next);
      if (expired) onHeadGoneRef.current(head, true);
    }, connectTiming.tickMs);
    return () => {
      clearInterval(ticker);
    };
  }, [active, hasEntries]);

  /** Pedido resolvido aqui (aceito, recusado, vencido): não volta a aparecer. */
  const dismiss = useCallback((id: string) => {
    setState((previous) => {
      const next = {
        ...previous,
        dismissed: new Set([...previous.dismissed, id]),
        entries: previous.entries.filter((entry) => entry.request.id !== id),
      };
      stateRef.current = next;
      return next;
    });
  }, []);

  /** Pedido que chegou por outro caminho (simulação em dev): aparece sem esperar o polling. */
  const inject = useCallback((request: ConnectionRequest) => {
    setState((previous) => {
      if (previous.entries.some((entry) => entry.request.id === request.id)) return previous;
      const now = connectClock.now();
      const next = {
        ...previous,
        now,
        entries: [...previous.entries, { request, deadline: now + request.expiresInS * 1000 }],
      };
      stateRef.current = next;
      return next;
    });
  }, []);

  /** Um pedido pendente de @handle (para o aceite pelo QR lido na aba "QR code" ou deep link). */
  const findFrom = useCallback(
    (handle: string): IncomingEntry | null =>
      stateRef.current.entries.find(
        (entry) =>
          entry.request.other.handle === handle &&
          !stateRef.current.dismissed.has(entry.request.id),
      ) ?? null,
    [],
  );

  const head = active ? headOf(state) : null;
  const secondsLeft = head === null ? 0 : Math.max(0, (head.deadline - state.now) / 1000);
  return { head, secondsLeft, dismiss, inject, findFrom };
}
