import { ApiError, NetworkError } from '../../lib/api/errors';

/** Estados que param a tela inteira (ux.md §5.2, estados 18 a 20): só "Tentar de novo" sai deles. */
export type HaltReason = 'paused' | 'unavailable' | 'offline' | 'emailNotVerified';

/**
 * Erro que para a tela: 429 (limite ou bloqueio de 15 min) → "Muitas tentativas"; Redis fora ou
 * 5xx → "Conectar está indisponível agora"; criador (403, nunca deveria chegar aqui) também; sem
 * rede → "Sem internet"; e-mail não confirmado. `null`: o erro é tratado onde aconteceu (Toast ou
 * mensagem no cartão e na folha).
 */
export function haltReasonFor(error: unknown): HaltReason | null {
  if (error instanceof NetworkError) return 'offline';
  if (!(error instanceof ApiError)) return 'unavailable';
  if (error.code === 'RATE_LIMITED') return 'paused';
  if (error.code === 'EMAIL_NOT_VERIFIED') return 'emailNotVerified';
  if (error.code === 'ACCOUNT_TYPE_NOT_ALLOWED') return 'unavailable';
  if (error.code === 'PROXIMITY_UNAVAILABLE' || error.status >= 500) return 'unavailable';
  return null;
}

/** Código de erro do módulo nativo (`ERR_BLUETOOTH_UNAVAILABLE`, …), se houver. */
export function nativeErrorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return null;
}
