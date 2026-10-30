import { z } from 'zod';

/**
 * Códigos de erro da API. O app usa o `code` para escolher a mensagem em pt-BR;
 * o `message` do servidor serve só para log e depuração (fase-0-plano.md §6.3).
 * Códigos de domínio entram nas fases que os usam.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  // Fase 1: autenticação, cadastro e conta.
  /** E-mail ou senha errados no login; senha errada ao excluir a conta. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** Senha com menos de 8 caracteres ou da lista de senhas comuns (AUTH-02). */
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  /** @ em uso, inclusive o de conta excluída, que nunca é reutilizado (A-14). */
  HANDLE_TAKEN: 'HANDLE_TAKEN',
  /** @ da lista de reservados (A-29). */
  HANDLE_RESERVED: 'HANDLE_RESERVED',
  /** Link de verificação de e-mail ou de redefinição de senha vencido, usado ou inexistente. */
  INVALID_TOKEN: 'INVALID_TOKEN',
  /** Rota restrita a um tipo de conta (ADR 0008). */
  ACCOUNT_TYPE_NOT_ALLOWED: 'ACCOUNT_TYPE_NOT_ALLOWED',
  // Fase 2: publicações, mídia e comentários.
  /**
   * Ação que exige e-mail confirmado (X.3): criar rascunho, post de texto, publicar e comentar (e,
   * na Fase 4, pedir conexão). Ler, curtir, perfil e conta continuam liberados.
   */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  /**
   * `publish` (ou `PUT /me/avatar`) com imagem que não chegou ao S3, enviada depois de a URL vencer
   * ou diferente da declarada (MID-07, MID-08). `details.positions` lista as fotos com problema.
   * (Fase 5) No reel, `details.positions` é `[0]` quando o vídeo faltou e `details.poster` é `true`
   * quando o poster faltou: o app reenvia só o que falta.
   */
  MEDIA_NOT_UPLOADED: 'MEDIA_NOT_UPLOADED',
  // Fase 4: conexão presencial (ADR 0003).
  /**
   * Redis/Valkey fora: a proximidade fica fechada (fail-closed, R11) e o app mostra "Conectar está
   * indisponível agora". Login, feed e perfil continuam funcionando (PROX-21).
   */
  PROXIMITY_UNAVAILABLE: 'PROXIMITY_UNAVAILABLE',
  /**
   * Quem chama não está com a tela Conectar aberta (nenhum token emitido nos últimos 30 s):
   * `resolve`, pedido e aceite são recusados (PROX-04, PROX-10). O app pede um token e tenta de novo.
   */
  PROXIMITY_SCREEN_CLOSED: 'PROXIMITY_SCREEN_CLOSED',
  /**
   * Mensagem genérica do pedido e do aceite: token de proximidade inexistente, vencido, de outra
   * pessoa, de conta excluída, com bloqueio em qualquer sentido ou dentro do intervalo de 1 h depois
   * de uma recusa. Mesmo corpo em todos os casos: nunca revela recusa nem bloqueio (PROX-17, X.2).
   */
  PROXIMITY_TOKEN_INVALID: 'PROXIMITY_TOKEN_INVALID',
  /** Pedido com o próprio token (inclusive de outro aparelho da mesma conta, PROX-07). */
  CANNOT_CONNECT_SELF: 'CANNOT_CONNECT_SELF',
  /** As duas contas já são conexão (PROX-19). */
  ALREADY_CONNECTED: 'ALREADY_CONNECTED',
  /** Aceite de pedido que passou dos 120 s (PROX-15). */
  REQUEST_EXPIRED: 'REQUEST_EXPIRED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorCodeSchema = z.enum(ErrorCode);

/** Item de `details` quando a validação de entrada falha. */
export const ValidationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/** Formato único de erro da API: `{ code, message, details? }`. */
export const ErrorResponseSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  details: z.unknown().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Status HTTP padrão de cada código (o `DomainError` pode usar outro). */
export const defaultHttpStatusByCode: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  INVALID_CREDENTIALS: 401,
  WEAK_PASSWORD: 400,
  EMAIL_TAKEN: 409,
  HANDLE_TAKEN: 409,
  HANDLE_RESERVED: 400,
  INVALID_TOKEN: 400,
  ACCOUNT_TYPE_NOT_ALLOWED: 403,
  EMAIL_NOT_VERIFIED: 403,
  MEDIA_NOT_UPLOADED: 409,
  PROXIMITY_UNAVAILABLE: 503,
  PROXIMITY_SCREEN_CLOSED: 409,
  PROXIMITY_TOKEN_INVALID: 400,
  CANNOT_CONNECT_SELF: 400,
  ALREADY_CONNECTED: 409,
  REQUEST_EXPIRED: 410,
};

/** Converte um status HTTP no código de erro correspondente. */
export function errorCodeFromHttpStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.BAD_REQUEST;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 405:
      return ErrorCode.METHOD_NOT_ALLOWED;
    case 409:
      return ErrorCode.CONFLICT;
    case 413:
      return ErrorCode.PAYLOAD_TOO_LARGE;
    case 422:
      return ErrorCode.VALIDATION_ERROR;
    case 429:
      return ErrorCode.RATE_LIMITED;
    case 503:
      return ErrorCode.SERVICE_UNAVAILABLE;
    default:
      return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST;
  }
}
