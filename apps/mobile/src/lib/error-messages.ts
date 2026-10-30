import { ErrorCode } from '@sussurro/shared';

import { ApiError, NetworkError } from './api/errors';

/**
 * Mensagem em pt-BR para cada código de erro da API (ux.md §5.1 e §5.4). O `message` do servidor
 * nunca aparece cru para a pessoa (fase-0-plano.md §6.3, AUTH-14). Como o mapa cobre todo
 * `ErrorCode`, um código novo em `packages/shared` sem mensagem aqui quebra o typecheck.
 */
const MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.VALIDATION_ERROR]: 'Confira os campos e tente de novo.',
  [ErrorCode.BAD_REQUEST]: 'Não foi possível concluir. Tente de novo.',
  [ErrorCode.UNAUTHORIZED]: 'Sua sessão expirou. Entre de novo.',
  [ErrorCode.FORBIDDEN]: 'Você não tem permissão para fazer isso.',
  [ErrorCode.NOT_FOUND]: 'Não encontramos o que você procurava.',
  [ErrorCode.METHOD_NOT_ALLOWED]: 'Não foi possível concluir. Tente de novo.',
  [ErrorCode.CONFLICT]: 'Isso já foi feito ou está em uso.',
  [ErrorCode.PAYLOAD_TOO_LARGE]: 'O arquivo é grande demais.',
  [ErrorCode.RATE_LIMITED]: 'Muitas tentativas. Espere um pouco e tente de novo.',
  [ErrorCode.INTERNAL_ERROR]: 'Algo deu errado do nosso lado. Tente de novo.',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'Algo deu errado do nosso lado. Tente de novo.',
  [ErrorCode.INVALID_CREDENTIALS]: 'E-mail ou senha incorretos.',
  [ErrorCode.WEAK_PASSWORD]: 'Use pelo menos 8 caracteres e evite senhas comuns.',
  [ErrorCode.EMAIL_TAKEN]: 'Este e-mail já está em uso.',
  [ErrorCode.HANDLE_TAKEN]: 'Este nome de usuário já está em uso.',
  [ErrorCode.HANDLE_RESERVED]: 'Este nome de usuário não está disponível.',
  [ErrorCode.INVALID_TOKEN]: 'Este link venceu ou já foi usado. Peça um novo.',
  [ErrorCode.ACCOUNT_TYPE_NOT_ALLOWED]: 'Essa ação não está disponível para o seu tipo de conta.',
  // Fase 2 (contrato da API; as telas chegam na Fase 2b).
  [ErrorCode.EMAIL_NOT_VERIFIED]: 'Confirme seu e-mail para publicar e comentar.',
  [ErrorCode.MEDIA_NOT_UPLOADED]: 'Não foi possível enviar as fotos. Tente de novo.',
  // Fase 4 (contrato da API, textos do ux.md §5.2; as telas chegam na Fase 4b).
  [ErrorCode.PROXIMITY_UNAVAILABLE]:
    'Conectar está indisponível agora. Tente de novo em instantes.',
  [ErrorCode.PROXIMITY_SCREEN_CLOSED]: 'Abra a tela Conectar para continuar.',
  [ErrorCode.PROXIMITY_TOKEN_INVALID]: 'Não foi possível enviar o pedido agora. Tente mais tarde.',
  [ErrorCode.CANNOT_CONNECT_SELF]: 'Este código é da sua própria conta.',
  [ErrorCode.ALREADY_CONNECTED]: 'Vocês já estão conectados.',
  [ErrorCode.REQUEST_EXPIRED]: 'O pedido expirou.',
};

export const OFFLINE_MESSAGE = 'Sem conexão com a internet. Tente de novo.';

export function errorMessage(code: ErrorCode): string {
  return MESSAGES[code];
}

/** Mensagem para qualquer erro de uma chamada à API (rede, HTTP ou inesperado). */
export function messageForError(error: unknown): string {
  if (error instanceof NetworkError) {
    return OFFLINE_MESSAGE;
  }
  if (error instanceof ApiError) {
    return errorMessage(error.code);
  }
  return errorMessage(ErrorCode.INTERNAL_ERROR);
}
