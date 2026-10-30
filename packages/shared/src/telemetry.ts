// Limpeza dos eventos de erro e de tracing antes de saírem para o Sentry (história 6.7, PERM-17).
// Funções puras sobre objetos simples (sem depender do SDK): a API e o worker usam no `beforeSend`
// e no `beforeSendTransaction`; o app pode usar o mesmo (Fase 6b).

/** O que entra no lugar de um valor sensível. */
export const TELEMETRY_REDACTED = '[Filtered]';

/** Normaliza a chave: minúsculas, sem `_`, `-` nem espaços (`refresh_token` = `refreshToken`). */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Chaves cujos valores nunca saem (6.7 CA1): credenciais, tokens (inclusive `observedToken`,
 * `targetToken`, `expoToken` e push tokens), cookies e segredos.
 */
const SENSITIVE_KEY_PARTS = [
  'authorization',
  'cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'credential',
  'privatekey',
  'dsn',
];

/**
 * Listas e ids de relacionamento (6.7 CA2, ADR 0004): somem do evento, com a chave. Quem segue
 * quem, quem é conexão, quem bloqueou e os dois lados de um pedido ou de uma notificação.
 */
const RELATIONSHIP_KEYS = new Set([
  'connections',
  'connection',
  'following',
  'followers',
  'follows',
  'blocks',
  'blocked',
  'blockedby',
  'followerid',
  'followerids',
  'creatorid',
  'creatorids',
  'blockerid',
  'blockedid',
  'useraid',
  'userbid',
  'fromid',
  'toid',
  'actorid',
  'recipientid',
  'otherid',
  'connectedids',
]);

/** Cabeçalhos que saem do evento inteiros (credenciais e o IP de quem chamou). */
const DROPPED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-refresh-token',
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'proxy-authorization',
]);

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function isRelationshipKey(key: string): boolean {
  return RELATIONSHIP_KEYS.has(normalizeKey(key));
}

/** Dados da pessoa (o equivalente ao `sendDefaultPii: false`): usuário, e-mail e IP somem. */
export function isPersonalKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    normalized === 'user' ||
    normalized.startsWith('user.') ||
    normalized.startsWith('enduser') ||
    normalized.includes('email') ||
    normalized.includes('ipaddress') ||
    normalized === 'client.address'
  );
}

/**
 * Padrões redigidos dentro de qualquer texto (mensagens de erro, breadcrumbs, URLs). Sem `\p{…}` nem
 * lookbehind, para valer igual no Hermes do app; os quantificadores têm limite onde um texto longo
 * sem separadores poderia custar caro.
 */
const TEXT_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // PERM-17: a mensagem do `DrizzleQueryError` é `Failed query: <sql>\nparams: <valores>`. Os
  // valores (e-mail, hash da senha, nome, bio, textos) podem ter quebra de linha: sai tudo até o fim.
  [/(^|\r?\n|\\n)params:[\s\S]*/g, `$1params: ${TELEMETRY_REDACTED}`],
  // Hash de senha no formato PHC (`$argon2id$v=19$m=…,t=…,p=…$sal$hash`), com as vírgulas.
  [/\$argon2(?:id|i|d)\$[\w$=,+/.-]*/g, TELEMETRY_REDACTED],
  // E-mail (parte local de até 64 caracteres, domínio com TLD de letras: `pacote@1.2.3` fica).
  [
    /[\w\u00C0-\u024F.!#$%&'*+=?^`{|}~-]{1,64}@(?:[A-Za-z0-9\u00C0-\u024F-]{1,63}\.)+[A-Za-z\u00C0-\u024F]{2,63}/g,
    TELEMETRY_REDACTED,
  ],
  // Valor recusado pelo Postgres: `invalid input syntax for type uuid: "…"`.
  [
    /((?:invalid input (?:syntax|value) for|out of range)[^:\n]{0,200}: )"[^"\n]*"/gi,
    `$1"${TELEMETRY_REDACTED}"`,
  ],
  [/\bBearer\s+[\w.~+/=-]+/gi, `Bearer ${TELEMETRY_REDACTED}`],
  // JWT (três partes base64url).
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, TELEMETRY_REDACTED],
  [/Expo(nent)?PushToken\[[^\]]*\]/g, TELEMETRY_REDACTED],
  // Detalhe de erro do Postgres: `Key (follower_id, creator_id)=(uuid, uuid) already exists`.
  [/\bKey \(([^)]*)\)=\([^)]*\)/g, `Key ($1)=(${TELEMETRY_REDACTED})`],
  // Parâmetros sensíveis em query strings e corpos de formulário.
  [
    /((?:^|[?&;])(?:[\w-]*token|password|secret|code|cursor)=)[^&#\s]*/gi,
    `$1${TELEMETRY_REDACTED}`,
  ],
];

export function scrubText(value: string): string {
  return TEXT_PATTERNS.reduce((text, [pattern, replacement]) => {
    return text.replace(pattern, replacement);
  }, value);
}

/** URL sem a query string nem o fragmento (cursores e parâmetros não saem). */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lista de contas (objetos com `handle`): uma lista de relacionamento, que nunca sai inteira. */
function isAccountList(value: unknown[]): boolean {
  return value.some((item) => isPlainObject(item) && 'handle' in item);
}

const MAX_DEPTH = 12;

/** Cópia profunda com as regras acima. Ciclos e profundidade demais viram `[Filtered]`. */
function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return scrubText(value);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth > MAX_DEPTH || seen.has(value)) {
    return TELEMETRY_REDACTED;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return isAccountList(value)
      ? TELEMETRY_REDACTED
      : value.map((item) => scrubValue(item, depth + 1, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (isRelationshipKey(key) || isPersonalKey(key)) {
      continue;
    }
    if (isSensitiveKey(key)) {
      result[key] = TELEMETRY_REDACTED;
      continue;
    }
    result[key] =
      typeof inner === 'string' ? scrubString(key, inner) : scrubValue(inner, depth + 1, seen);
  }
  return result;
}

/**
 * Texto com a chave em mãos: query string (`url.query`, `http.query`) sai inteira; URL e alvo
 * (`url`, `url.full`, `http.url`, `http.target`, `avatarUrl`) ficam sem a query (cursores, URLs
 * assinadas); o resto passa pelos padrões de texto.
 */
function scrubString(key: string, value: string): string {
  const normalized = normalizeKey(key);
  if (normalized.includes('query')) {
    return TELEMETRY_REDACTED;
  }
  if (normalized.includes('url') || normalized.includes('target')) {
    return scrubText(stripQuery(value));
  }
  return scrubText(value);
}

/** O pedaço `request` de um evento do Sentry (só o que esta limpeza mexe). */
interface TelemetryRequest {
  url?: string;
  data?: unknown;
  cookies?: unknown;
  query_string?: unknown;
  env?: unknown;
  headers?: Record<string, unknown>;
  [key: string]: unknown;
}

function scrubRequest(request: TelemetryRequest): TelemetryRequest {
  const { data: _data, cookies: _cookies, query_string: _query, env: _env, ...rest } = request;
  const cleaned = scrubValue(rest, 0, new WeakSet()) as TelemetryRequest;
  if (typeof request.url === 'string') {
    cleaned.url = scrubText(stripQuery(request.url));
  }
  if (isPlainObject(request.headers)) {
    cleaned.headers = Object.fromEntries(
      Object.entries(request.headers)
        .filter(([name]) => !DROPPED_HEADERS.has(name.toLowerCase()))
        .map(([name, inner]) => [
          name,
          isSensitiveKey(name)
            ? TELEMETRY_REDACTED
            : typeof inner === 'string'
              ? scrubText(inner)
              : inner,
        ]),
    );
  }
  return cleaned;
}

/**
 * Limpa um evento de erro ou de transação antes do envio (PERM-17; 6.7 CA1 e CA2):
 * - `user` sai inteiro (equivale ao `sendDefaultPii: false`: sem id, e-mail nem IP);
 * - da requisição saem o corpo, os cookies, a query string, o ambiente e os cabeçalhos de
 *   credencial e de IP; a URL fica sem a query;
 * - em qualquer lugar (`extra`, `contexts`, `tags`, breadcrumbs, spans, variáveis locais):
 *   chaves sensíveis viram `[Filtered]`, chaves de relacionamento somem e listas de contas (objetos
 *   com `handle`) viram `[Filtered]`;
 * - em qualquer texto (mensagens de erro e de breadcrumbs): `Bearer …`, JWT, push token do Expo, o
 *   detalhe `Key (…)=(…)` do Postgres, parâmetros como `token=` e `cursor=` e, desde a correção do
 *   PERM-17, os `params:` de uma consulta que falhou, e-mails e hashes `$argon2…$…`.
 *
 * É a segunda barreira: o erro já sai limpo do código (`sanitizeError`, em `safe-error.ts`).
 */
export function scrubTelemetryEvent<T extends object>(event: T): T {
  const { request, user: _user, ...rest } = event as Record<string, unknown>;
  const cleaned = scrubValue(rest, 0, new WeakSet()) as Record<string, unknown>;
  if (isPlainObject(request)) {
    cleaned.request = scrubRequest(request);
  }
  return cleaned as T;
}
