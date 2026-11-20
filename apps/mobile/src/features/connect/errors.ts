import { ApiError, NetworkError } from '../../lib/api/errors';

/** Estados que param a tela inteira (ux.md §5.2, estados 18 a 20): só "Tentar de novo" sai deles. */
export type HaltReason = 'paused' | 'unavailable' | 'offline' | 'emailNotVerified';

/**
 * A renovação dos tokens não saiu porque a tela Conectar parou (18 a 20), foi para o segundo plano
 * ou fechou: antes de a vaga do teto abrir (PROX-68), ou antes mesmo de pedir (o 409 "tela fechada"
 * que chega com a tela inativa ou desmontada). Não é um erro para mostrar: quem esperava (o
 * `refresh` e o `withScreenOpen`) termina em silêncio, como se a tela já tivesse parado (o `halt`
 * do `useConnectSession` o trata assim).
 */
export class TokenWaitCancelled extends Error {
  constructor() {
    super('A espera pela vaga das emissões de tokens foi cancelada.');
    this.name = 'TokenWaitCancelled';
  }
}

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

/**
 * Falha repetível: sem resposta (`NetworkError`) ou 5xx (o 503 do Valkey fora, inclusive). A
 * renovação do token tenta de novo antes de parar a tela. O resto (429, 403, 400…) para na hora.
 */
export function isRepeatableFailure(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof ApiError && error.status >= 500);
}

/** Código de erro do módulo nativo (`ERR_NFC_DISABLED`, …), se houver. */
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
