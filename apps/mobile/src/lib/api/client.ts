import {
  ErrorCode,
  errorCodeFromHttpStatus,
  ErrorResponseSchema,
  type TokenPair,
  TokenPairSchema,
} from '@sussurro/shared';

import { ApiError, NetworkError } from './errors';

/** O mínimo de `fetch` que o cliente usa (facilita os testes). */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

/**
 * Onde o refresh token fica entre aberturas do app (secure-store no aparelho). O access token
 * nunca passa por aqui: fica só em memória (ADR 0007, AUTH-13).
 */
export interface RefreshTokenStore {
  getRefreshToken: () => Promise<string | null>;
  setRefreshToken: (token: string) => Promise<void>;
  clearRefreshToken: () => Promise<void>;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Qualquer schema Zod de `packages/shared` serve: só o `parse` é usado. */
export interface ResponseParser<T> {
  parse: (value: unknown) => T;
}

export interface RequestOptions<T> {
  method?: HttpMethod;
  body?: unknown;
  /** Schema da resposta em `packages/shared` (para 204/202, `NoContentSchema`). */
  schema: ResponseParser<T>;
  /** `false` nas rotas públicas: não manda token e não tenta refresh. */
  auth?: boolean;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch: FetchLike;
  tokens: RefreshTokenStore;
}

async function readJson(response: HttpResponse): Promise<unknown> {
  const text = await response.text();
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function toApiError(response: HttpResponse): Promise<ApiError> {
  const parsed = ErrorResponseSchema.safeParse(await readJson(response));
  if (parsed.success) {
    return new ApiError(
      response.status,
      parsed.data.code,
      parsed.data.message,
      parsed.data.details,
    );
  }
  return new ApiError(response.status, errorCodeFromHttpStatus(response.status), 'Erro HTTP');
}

/**
 * Cliente HTTP do app (ADR 0007):
 * - access token só em memória; refresh no secure-store;
 * - 401 `UNAUTHORIZED` dispara o refresh em *single-flight* (várias chamadas com 401 ao mesmo
 *   tempo geram um refresh só) e repete cada chamada uma vez (AUTH-10);
 * - refresh recusado limpa a sessão e avisa quem estiver ouvindo (`onSessionExpired`).
 */
export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  private sessionExpiredListener: (() => void) | null = null;

  constructor(private readonly options: ApiClientOptions) {}

  /** Chamado quando o refresh é recusado no meio do uso (sessão expirada ou revogada). */
  onSessionExpired(listener: (() => void) | null): void {
    this.sessionExpiredListener = listener;
  }

  /** Guarda um par novo (login, cadastro, refresh). */
  async setSession(tokens: TokenPair): Promise<void> {
    this.accessToken = tokens.accessToken;
    await this.options.tokens.setRefreshToken(tokens.refreshToken);
  }

  async clearSession(): Promise<void> {
    this.accessToken = null;
    await this.options.tokens.clearRefreshToken();
  }

  /** Abertura do app: troca o refresh guardado por um par novo. `false` = sem sessão. */
  restoreSession(): Promise<boolean> {
    return this.refreshSingleFlight();
  }

  async request<T>(path: string, options: RequestOptions<T>): Promise<T> {
    return this.execute(path, options, false);
  }

  private async execute<T>(path: string, options: RequestOptions<T>, retried: boolean): Promise<T> {
    const auth = options.auth !== false;
    const tokenUsed = auth ? this.accessToken : null;
    const response = await this.send(path, options.method ?? 'GET', options.body, tokenUsed);
    if (response.ok) {
      return options.schema.parse(await readJson(response));
    }
    const error = await toApiError(response);
    if (auth && !retried && error.status === 401 && error.code === ErrorCode.UNAUTHORIZED) {
      // Se outra chamada já renovou o token enquanto esta voava, só repete.
      const renewed =
        this.accessToken !== null && this.accessToken !== tokenUsed
          ? true
          : await this.refreshSingleFlight();
      if (renewed) {
        return this.execute(path, options, true);
      }
      this.sessionExpiredListener?.();
    }
    throw error;
  }

  private refreshSingleFlight(): Promise<boolean> {
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** `true` com par novo; `false` sem refresh guardado ou com refresh recusado (401). */
  private async refresh(): Promise<boolean> {
    const refreshToken = await this.options.tokens.getRefreshToken();
    if (refreshToken === null) {
      this.accessToken = null;
      return false;
    }
    const response = await this.send('/v1/auth/refresh', 'POST', { refreshToken }, null);
    if (response.status === 401) {
      await this.clearSession();
      return false;
    }
    if (!response.ok) {
      // 429/5xx: a sessão continua guardada; quem chamou mostra o erro.
      throw await toApiError(response);
    }
    await this.setSession(TokenPairSchema.parse(await readJson(response)));
    return true;
  }

  private async send(
    path: string,
    method: HttpMethod,
    body: unknown,
    accessToken: string | null,
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (accessToken !== null) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    try {
      return await this.options.fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new NetworkError(error);
    }
  }
}
