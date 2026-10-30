import { ApiError, isApiError, NetworkError } from '../../lib/api/errors';

/** Estados que param a tela inteira (ux.md §5.2): só "Tentar de novo" sai deles. */
export type HaltReason = 'paused' | 'unavailable' | 'offline' | 'emailNotVerified';

/**
 * Erro que para a tela: 429 (limite ou bloqueio de 15 min) → "Muitas tentativas"; Redis fora ou
 * 5xx → "Conectar está indisponível agora"; sem rede → "Sem internet"; e-mail não confirmado.
 * `null`: o erro é tratado onde aconteceu (Toast ou mensagem na folha).
 */
export function haltReasonFor(error: unknown): HaltReason | null {
  if (error instanceof NetworkError) return 'offline';
  if (!(error instanceof ApiError)) return 'unavailable';
  if (error.code === 'RATE_LIMITED') return 'paused';
  if (error.code === 'EMAIL_NOT_VERIFIED') return 'emailNotVerified';
  if (error.code === 'PROXIMITY_UNAVAILABLE' || error.status >= 500) return 'unavailable';
  return null;
}

/** Os tokens do `resolve` voltam para a fila (falha passageira) ou são descartados. */
export function isRetryableResolveError(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    isApiError(error, 'PROXIMITY_SCREEN_CLOSED') ||
    isApiError(error, 'RATE_LIMITED') ||
    (error instanceof ApiError && error.status >= 500)
  );
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
