import { connectClock, connectTiming } from './timing';

/**
 * Deep link do QR sem sessão (`sussurro://c/{token}`, ux.md §3.2 e 4.7 CA6): o token fica só em
 * memória (nunca no aparelho) enquanto a pessoa entra, e é descartado se passaram mais de 30 s.
 */
let pending: { token: string; savedAt: number } | null = null;

export function savePendingQrToken(token: string, now: number = connectClock.now()): void {
  pending = { token, savedAt: now };
}

/** O token guardado, se ainda vale; sempre esquece o que estava guardado. */
export function takePendingQrToken(now: number = connectClock.now()): string | null {
  const value = pending;
  pending = null;
  if (value === null || now - value.savedAt > connectTiming.pendingLinkTtlMs) return null;
  return value.token;
}
