import * as Sentry from '@sentry/react-native';
import { scrubTelemetryEvent, scrubText, stripQuery } from '@sussurro/shared';
import Constants from 'expo-constants';

import { apiBaseUrl } from './api/config';

let initialized = false;

/** Variante do build (development/preview/production), gravada no app.config.ts. */
export function appVariant(): string {
  const extra = Constants.expoConfig?.extra as { appVariant?: string } | undefined;
  return extra?.appVariant ?? 'development';
}

/**
 * Amostragem do tracing (0 a 1) por perfil do EAS (`EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`).
 * Vazia ou inválida = 0 (sem tracing), como no servidor.
 */
export function tracesSampleRate(
  value: string | undefined = process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
): number {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') return 0;
  const rate = Number(trimmed);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Segmentos seguidos de um @ (API: `users`, `creators`, `connections`, `blocks`; app: `u`). */
const HANDLE_AFTER = new Set(['users', 'creators', 'connections', 'blocks', 'u']);
/** Rotas fixas que vêm depois desses segmentos e não são @ (`/connections/requests/...`). */
const STATIC_AFTER_HANDLE_SEGMENT = new Set(['requests']);

/**
 * Caminho (da API, do S3 ou do app) sem nada que identifique alguém: sem a query, ids viram `:id`,
 * o @ vira `:handle` e o token do QR (`/c/{token}`) vira `:token`. Ex.:
 * `https://api/v1/creators/cozinhadabia/follow` → `https://api/v1/creators/:handle/follow`.
 * Quem a pessoa segue, de quem é conexão ou quem bloqueou não vai para o Sentry (6.7 CA2).
 */
export function maskPath(url: string): string {
  const clean = stripQuery(url);
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)?(.*)$/i.exec(clean);
  const origin = match?.[1] ?? '';
  const segments = (match?.[2] ?? '').split('/');
  const masked = segments.map((segment, index) => {
    if (segment === '') return segment;
    if (UUID.test(segment)) return ':id';
    const previous = segments[index - 1] ?? '';
    if (previous === 'c') return ':token';
    if (HANDLE_AFTER.has(previous) && !STATIC_AFTER_HANDLE_SEGMENT.has(segment)) return ':handle';
    return segment;
  });
  return scrubText(`${origin}${masked.join('/')}`);
}

/** URLs e caminhos da API dentro de um texto (descrição de span, mensagem de breadcrumb). */
function maskUrlsInText(text: string): string {
  return text.replace(/(?:[a-z][a-z0-9+.-]*:\/\/[^\s"']+|\/v1\/[^\s"']*)/gi, (url) =>
    maskPath(url),
  );
}

/** Chaves de breadcrumb com URL ou rota (fetch/xhr e navegação). */
const URL_KEYS = ['url', 'from', 'to'] as const;

/**
 * Breadcrumb antes de entrar no escopo (e de ir para o SDK nativo): toques saem inteiros (rótulos
 * podem ter @); URLs e rotas ficam sem @, ids e query; o resto passa pela limpeza do
 * `packages/shared` (tokens, `Bearer`, JWT, chaves sensíveis e de relacionamento).
 */
export function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  if (breadcrumb.category === 'touch' || breadcrumb.category === 'ui.click') return null;
  const data: Record<string, unknown> | undefined =
    breadcrumb.data === undefined ? undefined : { ...breadcrumb.data };
  if (data !== undefined) {
    for (const key of URL_KEYS) {
      const value = data[key];
      if (typeof value === 'string') data[key] = maskPath(value);
    }
  }
  const cleaned = scrubTelemetryEvent({
    ...breadcrumb,
    ...(data === undefined ? {} : { data }),
  });
  return typeof cleaned.message === 'string'
    ? { ...cleaned, message: maskUrlsInText(cleaned.message) }
    : cleaned;
}

/** Spans HTTP do tracing: a descrição (`GET https://api/v1/users/x`) sem @ nem ids. */
function maskSpans<T extends { spans?: { description?: string }[]; transaction?: string }>(
  event: T,
): T {
  const spans = event.spans?.map((span) =>
    span.description === undefined
      ? span
      : { ...span, description: maskUrlsInText(span.description) },
  );
  return {
    ...event,
    ...(spans === undefined ? {} : { spans }),
    ...(event.transaction === undefined ? {} : { transaction: maskUrlsInText(event.transaction) }),
  };
}

/** Evento de erro do JavaScript antes do envio (PERM-17; 6.7 CA1 e CA2). */
export function scrubErrorEvent<T extends object>(event: T): T {
  const cleaned = scrubTelemetryEvent(event) as T & {
    breadcrumbs?: Sentry.Breadcrumb[];
    request?: { url?: unknown };
  };
  const request =
    typeof cleaned.request?.url === 'string'
      ? { request: { ...cleaned.request, url: maskPath(cleaned.request.url) } }
      : {};
  const breadcrumbs =
    cleaned.breadcrumbs === undefined
      ? {}
      : {
          breadcrumbs: cleaned.breadcrumbs.flatMap((breadcrumb) => {
            const safe = scrubBreadcrumb(breadcrumb);
            return safe === null ? [] : [safe];
          }),
        };
  return { ...cleaned, ...request, ...breadcrumbs };
}

/** Transação do tracing antes do envio: a mesma limpeza e as URLs dos spans mascaradas. */
export function scrubTransactionEvent<T extends object>(event: T): T {
  return maskSpans(scrubErrorEvent(event) as T & { spans?: { description?: string }[] });
}

export interface SentrySettings {
  dsn: string;
  environment: string;
  tracesSampleRate: number;
  apiUrl: string;
}

/**
 * Opções do Sentry do app (6.7, D4):
 * - sem dados pessoais (`sendDefaultPii: false`) e nenhum `setUser` no app;
 * - `beforeSend`, `beforeSendTransaction` e `beforeBreadcrumb` com a limpeza do `packages/shared`
 *   (`scrubTelemetryEvent`) e as URLs sem @ e ids;
 * - sem sessões de release health, captura de tela nem hierarquia de views;
 * - release e `dist` do próprio SDK (`bundleId@versão+build`, por variante), iguais aos do upload
 *   dos source maps no EAS; o ambiente é a variante;
 * - tracing só com amostragem maior que 0, com o `sentry-trace` só para a API (nunca S3 ou Expo).
 */
export function sentryOptions({
  dsn,
  environment,
  tracesSampleRate: rate,
  apiUrl,
}: SentrySettings): Sentry.ReactNativeOptions {
  return {
    dsn,
    environment,
    // O SDK do RN 8.28 omite `dataCollection` das opções: `sendDefaultPii` é a forma suportada.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    sendDefaultPii: false,
    tracesSampleRate: rate,
    tracePropagationTargets: [apiUrl],
    enableAutoSessionTracking: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    beforeSend: (event) => scrubErrorEvent(event),
    beforeSendTransaction: (event) => scrubTransactionEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  };
}

/** `true` depois do `initSentry` com DSN. */
export function isSentryEnabled(): boolean {
  return initialized;
}

/**
 * Erro de teste (6.7 CA3): conferir no Sentry o stack com source maps, a release e o ambiente de um
 * build do EAS. Só pelo catálogo de desenvolvimento. `false` com o Sentry desligado (sem DSN).
 */
export function sendTestError(): boolean {
  if (!initialized) return false;
  Sentry.captureException(new Error('Erro de teste do catálogo (6.7 CA3)'));
  return true;
}

/**
 * Sentry do app: só inicializa com `EXPO_PUBLIC_SENTRY_DSN` (decisão D4). Sem DSN nada é
 * inicializado nem enviado.
 */
export function initSentry(
  dsn: string | undefined = process.env.EXPO_PUBLIC_SENTRY_DSN,
  environment: string = appVariant(),
  rate: number = tracesSampleRate(),
): boolean {
  const trimmed = dsn?.trim();
  if (initialized || trimmed === undefined || trimmed === '') {
    return initialized;
  }
  Sentry.init(
    sentryOptions({ dsn: trimmed, environment, tracesSampleRate: rate, apiUrl: apiBaseUrl() }),
  );
  initialized = true;
  return true;
}
