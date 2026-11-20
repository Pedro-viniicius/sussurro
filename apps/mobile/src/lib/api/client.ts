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

/** `signal`: aborta a conexão no fim do prazo da chamada (`RequestOptions.timeoutMs`). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
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
  /**
   * Prazo da chamada inteira (envio, refresh e leitura da resposta), em ms. No fim, a conexão é
   * abortada pelo `AbortController` (o `signal` vai no `fetch`) e a chamada falha com
   * `NetworkError`. Sem ele, a chamada espera o sistema desistir.
   */
  timeoutMs?: number;
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

/**
 * O fim de um refresh: `renewed` com o par novo guardado; `expired` sem refresh guardado ou com o
 * refresh recusado (401), com a época em que a sessão terminou; `stale` quando a sessão trocou no
 * meio (login ou saída), e o resultado foi descartado.
 */
type RefreshOutcome = { kind: 'renewed' } | { kind: 'expired'; epoch: number } | { kind: 'stale' };

const STALE: RefreshOutcome = { kind: 'stale' };

function toApiError(status: number, body: unknown): ApiError {
  const parsed = ErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    return new ApiError(status, parsed.data.code, parsed.data.message, parsed.data.details);
  }
  return new ApiError(status, errorCodeFromHttpStatus(status), 'Erro HTTP');
}

/**
 * Cliente HTTP do app (ADR 0007):
 * - access token só em memória; refresh no secure-store;
 * - 401 `UNAUTHORIZED` dispara o refresh em *single-flight* (várias chamadas com 401 ao mesmo
 *   tempo geram um refresh só) e repete cada chamada uma vez (AUTH-10);
 * - refresh recusado limpa a sessão e avisa quem estiver ouvindo (`onSessionExpired`);
 * - a **época** da sessão separa uma sessão da outra: muda no login e no cadastro (`setSession`) e
 *   no fim da sessão (`clearSession`), nunca no refresh. A chamada que começou numa época e recebe o
 *   401 em outra (sair de A e entrar em B no meio do voo) não é repetida: a repetição levaria o
 *   token de B, e a ação de A (post, bloqueio, denúncia, relato) rodaria na conta B. Ela falha com o
 *   401, sem refresh e sem o aviso de sessão expirada (a sessão de B está bem). O refresh que volta
 *   depois da troca também é descartado: o par de A não pode substituir a sessão de B, nem o 401
 *   dele limpar a de B.
 */
export class ApiClient {
  private accessToken: string | null = null;
  /** A época da sessão (ver acima): sobe no login, no cadastro e no fim da sessão. */
  private sessionEpoch = 0;
  /** O refresh em voo e a época em que começou (um refresh de outra época não serve a esta). */
  private refreshing: { epoch: number; promise: Promise<RefreshOutcome> } | null = null;
  private sessionExpiredListener: (() => void) | null = null;

  constructor(private readonly options: ApiClientOptions) {}

  /** Chamado quando o refresh é recusado no meio do uso (sessão expirada ou revogada). */
  onSessionExpired(listener: (() => void) | null): void {
    this.sessionExpiredListener = listener;
  }

  /** Começa uma sessão com o par do login ou do cadastro (uma época nova). */
  async setSession(tokens: TokenPair): Promise<void> {
    this.sessionEpoch += 1;
    await this.storeTokens(tokens);
  }

  /** Termina a sessão (sair, conta excluída, refresh recusado): uma época nova, sem tokens. */
  async clearSession(): Promise<void> {
    this.sessionEpoch += 1;
    this.accessToken = null;
    await this.options.tokens.clearRefreshToken();
  }

  /** Guarda um par novo sem mudar a época (o refresh continua a mesma sessão). */
  private async storeTokens(tokens: TokenPair): Promise<void> {
    this.accessToken = tokens.accessToken;
    await this.options.tokens.setRefreshToken(tokens.refreshToken);
  }

  /** Abertura do app: troca o refresh guardado por um par novo. `false` = sem sessão. */
  async restoreSession(): Promise<boolean> {
    const outcome = await this.refreshSingleFlight();
    return outcome.kind === 'renewed';
  }

  async request<T>(path: string, options: RequestOptions<T>): Promise<T> {
    const { timeoutMs } = options;
    // A época em que a chamada começou: só ela pode repetir a chamada depois do 401.
    const epoch = this.sessionEpoch;
    if (timeoutMs === undefined) {
      return this.execute(path, options, false, undefined, epoch);
    }
    // O `abort` fecha a conexão (um `Promise.race` sozinho a deixaria aberta por trás); a corrida
    // com o prazo garante que a chamada termina no prazo mesmo com um `fetch` que ignore o `signal`.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new NetworkError(new Error(`Sem resposta em ${String(timeoutMs)} ms`)));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.execute(path, options, false, controller.signal, epoch),
        expired,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute<T>(
    path: string,
    options: RequestOptions<T>,
    retried: boolean,
    signal: AbortSignal | undefined,
    epoch: number,
  ): Promise<T> {
    const auth = options.auth !== false;
    const tokenUsed = auth ? this.accessToken : null;
    const response = await this.send(
      path,
      options.method ?? 'GET',
      options.body,
      tokenUsed,
      signal,
    );
    const body = await readJson(response);
    if (response.ok) {
      return options.schema.parse(body);
    }
    const error = toApiError(response.status, body);
    if (auth && !retried && error.status === 401 && error.code === ErrorCode.UNAUTHORIZED) {
      // A sessão trocou no meio do voo (sair de A e entrar em B): o token mudou, mas não foi
      // renovado. Não repete, não renova e não avisa (a sessão de agora não expirou).
      if (this.sessionEpoch !== epoch) throw error;
      // Se outra chamada já renovou o token enquanto esta voava (a mesma época), só repete.
      const outcome: RefreshOutcome =
        this.accessToken !== null && this.accessToken !== tokenUsed
          ? { kind: 'renewed' }
          : await this.refreshSingleFlight();
      // A sessão pode ter trocado também durante o refresh.
      if (outcome.kind === 'renewed' && this.sessionEpoch === epoch) {
        // O prazo acabou durante o refresh: a chamada já falhou, e a repetição nem sai.
        if (signal?.aborted === true) throw new NetworkError(new Error('Prazo esgotado'));
        return this.execute(path, options, true, signal, epoch);
      }
      // Avisa só se a sessão que expirou ainda é a de agora (nenhum login depois do refresh).
      if (outcome.kind === 'expired' && outcome.epoch === this.sessionEpoch) {
        this.sessionExpiredListener?.();
      }
    }
    throw error;
  }

  /** Um refresh por vez, e só para a época de agora (o de uma sessão anterior não serve). */
  private refreshSingleFlight(): Promise<RefreshOutcome> {
    const epoch = this.sessionEpoch;
    if (this.refreshing?.epoch === epoch) return this.refreshing.promise;
    const promise = this.refresh(epoch).finally(() => {
      if (this.refreshing?.promise === promise) this.refreshing = null;
    });
    this.refreshing = { epoch, promise };
    return promise;
  }

  /**
   * Troca o refresh guardado por um par novo, na época `epoch`. Se a sessão trocar no meio
   * (`stale`), o resultado é descartado: nada é guardado nem limpo, porque já é outra sessão.
   */
  private async refresh(epoch: number): Promise<RefreshOutcome> {
    const refreshToken = await this.options.tokens.getRefreshToken();
    if (this.sessionEpoch !== epoch) return STALE;
    if (refreshToken === null) {
      this.accessToken = null;
      return { kind: 'expired', epoch };
    }
    // Sem `signal`: o refresh é de todas as chamadas que esperam por ele, não só de uma.
    const response = await this.send('/v1/auth/refresh', 'POST', { refreshToken }, null, undefined);
    if (this.sessionEpoch !== epoch) return STALE;
    if (response.status === 401) {
      // O `clearSession` muda a época antes de esperar o armazenamento. Lida logo depois, ela é a
      // do fim desta sessão: um login durante a espera não recebe o aviso de sessão expirada.
      const clearing = this.clearSession();
      const ended = this.sessionEpoch;
      await clearing;
      return { kind: 'expired', epoch: ended };
    }
    if (!response.ok) {
      // 429/5xx: a sessão continua guardada; quem chamou mostra o erro.
      throw toApiError(response.status, await readJson(response));
    }
    const pair = TokenPairSchema.parse(await readJson(response));
    if (this.sessionEpoch !== epoch) return STALE;
    await this.storeTokens(pair);
    return { kind: 'renewed' };
  }

  private async send(
    path: string,
    method: HttpMethod,
    body: unknown,
    accessToken: string | null,
    signal: AbortSignal | undefined,
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
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new NetworkError(error);
    }
  }
}
