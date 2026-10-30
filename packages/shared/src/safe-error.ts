// Erro seguro para log e telemetria (PERM-17). O drizzle-orm embrulha toda falha do driver num
// `DrizzleQueryError` cuja mensagem é `Failed query: <sql>\nparams: <valores>`, com os campos
// `query`, `params` e `cause`. Os valores são os da consulta: e-mail de quem entra, hash da senha e
// nome de quem se cadastra, bio, textos de post e de comentário, detalhes de denúncia. Nada disso pode
// ir para o log (CloudWatch) nem para o Sentry: a API e o worker passam todo erro por aqui antes.
// Funções puras, sem depender do drizzle nem do SDK do Sentry (o app também importa este pacote).

import { scrubText } from './telemetry.ts';

/** Níveis de `cause` seguidos abaixo do erro de cima (o Drizzle embrulha o driver: 1 já basta). */
export const SAFE_ERROR_MAX_CAUSE_DEPTH = 3;

/** Erro limpo: nome, mensagem, `code` e stack só com os frames; `cause` também limpo. */
export type SafeError = Error & { readonly code?: string };

export interface DescribeSafeErrorOptions {
  /** Junta os frames do erro de cima (`    at …`) depois da descrição, para o log de um 5xx. */
  withStack?: boolean;
}

interface SafeErrorParts {
  name: string;
  message: string;
  code: string | undefined;
  frames: string[];
  cause: SafeErrorParts | undefined;
}

/** SQLSTATE (`23505`, `57P01`), códigos do Node (`ECONNREFUSED`) e os do domínio. */
const SAFE_CODE = /^[\w.-]{1,64}$/;
/** Nome de classe de erro (`Error`, `DatabaseError`, o `error` do `pg`). */
const SAFE_NAME = /^[A-Za-z_$][\w$.-]{0,63}$/;
/** Linha de frame do V8. */
const FRAME_LINE = /^\s+at\s/;

interface ErrorLike {
  name?: unknown;
  message: string;
  stack?: unknown;
  code?: unknown;
  cause?: unknown;
  query?: unknown;
  params?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike {
  return (
    value instanceof Error ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { message?: unknown }).message === 'string')
  );
}

/**
 * `DrizzleQueryError` pelo nome da classe (ela não muda o `name`, que fica `Error`) ou pela forma
 * (`query` em texto e `params`), sem importar o drizzle-orm.
 */
function isQueryError(error: ErrorLike): boolean {
  const className = (error as { constructor?: { name?: unknown } }).constructor?.name;
  return (
    className === 'DrizzleQueryError' || (typeof error.query === 'string' && 'params' in error)
  );
}

function textOf(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'Erro sem descrição';
  }
}

/**
 * Só os frames, nunca a mensagem: o stack começa repetindo a mensagem (no `DrizzleQueryError`, com
 * os `params`), e um valor com quebra de linha poderia imitar um frame. Por isso conta só o bloco de
 * frames do fim, depois da mensagem original.
 */
function framesOf(stack: unknown, message: string): string[] {
  if (typeof stack !== 'string') {
    return [];
  }
  const at = message === '' ? -1 : stack.indexOf(message);
  const lines = (at === -1 ? stack : stack.slice(at + message.length)).split('\n');
  let first = lines.length;
  while (first > 0 && FRAME_LINE.test(lines[first - 1] ?? '')) {
    first -= 1;
  }
  return lines.slice(first).map((line) => scrubText(line.trimEnd()));
}

/** Mensagem com o código no fim (`… [57014]`): o SQLSTATE é o que explica a falha no Sentry. */
function withCode(message: string, code: string | undefined, name: string): string {
  if (message === '') {
    return code ?? name;
  }
  return code === undefined || message.includes(code) ? message : `${message} [${code}]`;
}

function partsOf(error: unknown, depth: number): SafeErrorParts {
  if (!isErrorLike(error)) {
    return {
      name: 'Error',
      message: scrubText(textOf(error)),
      code: undefined,
      frames: [],
      cause: undefined,
    };
  }
  const queryError = isQueryError(error);
  const name = queryError
    ? 'DrizzleQueryError'
    : typeof error.name === 'string' && SAFE_NAME.test(error.name)
      ? error.name
      : 'Error';
  const code =
    typeof error.code === 'string' && SAFE_CODE.test(error.code) ? error.code : undefined;
  // Do `DrizzleQueryError` sai no máximo o SQL (com `$1`, `$2`…), nunca os `params`. Do erro do
  // driver saem a mensagem e o SQLSTATE; o `detail` (`Key (email)=(…)`) nunca é lido.
  const message = queryError
    ? typeof error.query === 'string'
      ? `Failed query: ${scrubText(error.query.trim())}`
      : 'Failed query'
    : scrubText(error.message.trim());
  const { cause } = error;
  return {
    name,
    message: withCode(message, code, name),
    code,
    frames: framesOf(error.stack, error.message),
    cause:
      cause !== undefined && cause !== null && depth < SAFE_ERROR_MAX_CAUSE_DEPTH
        ? partsOf(cause, depth + 1)
        : undefined,
  };
}

function toError(parts: SafeErrorParts): SafeError {
  const error: SafeError = new Error(parts.message);
  error.name = parts.name;
  error.stack = [`${parts.name}: ${parts.message}`, ...parts.frames].join('\n');
  if (parts.code !== undefined) {
    Object.assign(error, { code: parts.code });
  }
  if (parts.cause !== undefined) {
    error.cause = toError(parts.cause);
  }
  return error;
}

/**
 * Versão segura de qualquer erro, para log e telemetria (PERM-17). É sempre um `Error` novo:
 * - `DrizzleQueryError` vira `Failed query: <sql>`, sem os `params`;
 * - o `cause` (o erro do driver) fica com a mensagem e o `code` (SQLSTATE), sem o `detail`;
 * - toda mensagem passa pelo `scrubText` (e-mail, `$argon2…$…`, `params:`, tokens);
 * - o `stack` é refeito só com as linhas de frame (`    at …`), sem a mensagem original;
 * - a cadeia de `cause` para em `SAFE_ERROR_MAX_CAUSE_DEPTH` níveis.
 *
 * Ao Sentry vai este erro, nunca o original.
 */
export function sanitizeError(error: unknown): SafeError {
  return toError(partsOf(error, 0));
}

/**
 * Texto curto para log a partir de qualquer erro, já limpo: as mensagens da cadeia de `cause`
 * separadas por ` <- ` (ex.: `Failed query: select … <- canceling statement… [57014]`). Mensagem vazia
 * vira o `code` (o ECONNREFUSED do Windows chega como `AggregateError` sem mensagem).
 */
export function describeSafeError(error: unknown, options: DescribeSafeErrorOptions = {}): string {
  const top = partsOf(error, 0);
  const messages: string[] = [];
  for (let current: SafeErrorParts | undefined = top; current; current = current.cause) {
    messages.push(current.message);
  }
  const description = messages.join(' <- ');
  return options.withStack === true && top.frames.length > 0
    ? [description, ...top.frames].join('\n')
    : description;
}
