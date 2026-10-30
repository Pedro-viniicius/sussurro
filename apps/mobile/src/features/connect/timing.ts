import {
  CONNECTION_POLL_INTERVAL_S,
  PROXIMITY_RECENT_TTL_S,
  PROXIMITY_RESOLVE_MIN_INTERVAL_S,
  PROXIMITY_TOKEN_TTL_S,
} from '@sussurro/shared';

/**
 * Tempos da tela Conectar (ADR 0003, ux.md §5.2). Objeto mutável só para os testes encurtarem as
 * esperas; o app usa os padrões. Os tempos do token vêm do servidor (`renewInS`).
 */
export const connectTiming = {
  /** Polling da caixa de entrada (B) e do meu pedido (A), com a tela aberta. */
  pollMs: CONNECTION_POLL_INTERVAL_S * 1000,
  /** `resolve` em lote no máximo a cada 3 s (A-17). */
  resolveMinIntervalMs: PROXIMITY_RESOLVE_MIN_INTERVAL_S * 1000,
  /** "Ninguém por perto ainda" depois de 20 s sem ninguém (4.4 CA6). */
  nobodyAfterMs: 20_000,
  /** Sem anúncio visto há mais que isto, a pessoa sai da lista. */
  presenceMs: 10_000,
  /** No toque em "Conectar", sem anúncio há mais que isto: "saiu de perto" (PROX-25). */
  goneAfterMs: 5_000,
  /** Relógio da lista e da contagem "Expira em 1:45". */
  tickMs: 1_000,
  /** Leitor de tela: no máximo 1 anúncio de "encontrado por perto" a cada 3 s (ux.md §7.3). */
  announceEveryMs: 3_000,
  /** Deep link do QR sem sessão: o token é descartado depois de 30 s (4.7 CA6). */
  pendingLinkTtlMs: 30_000,
};

/** Validade do token para pedir (o app conta a partir da primeira vez que o viu). */
export const TOKEN_TTL_MS = PROXIMITY_TOKEN_TTL_S * 1000;
/** Janela "recente": o token de A ainda confirma o aceite (PROX-26). */
export const RECENT_TTL_MS = PROXIMITY_RECENT_TTL_S * 1000;

/** Relógio trocável nos testes (e fora do render, para as regras de pureza do React). */
export const connectClock = {
  now: (): number => Date.now(),
};
