import {
  PROXIMITY_TOUCH_PAIR_TTL_S,
  PROXIMITY_TOUCH_REPORT_FOR_S,
  PROXIMITY_TOUCH_WINDOW_S,
} from '@sussurro/shared';
import { z } from 'zod';

/**
 * (ADR 0012, A2-2) Latência do primeiro relato que a janela do encosto precisa deixar de folga: o
 * app relata por `PROXIMITY_TOUCH_REPORT_FOR_S` (8 s), e a janela + 2 s precisa caber nisso.
 */
const TOUCH_REPORT_LATENCY_S = 2;

/** Trata `VAR=` (vazia no .env) como ausente. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const required = (what: string) => ({
  error: (issue: { input?: unknown }) =>
    issue.input === undefined ? 'obrigatória' : `inválida (esperado ${what})`,
});

/** Inteiro positivo com padrão (TTLs e limites configuráveis por env, A-27). */
const positiveInt = (fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(fallback));

/** `true`/`false` (também `1`/`0`) com padrão. */
const booleanFlag = (fallback: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .enum(['true', 'false', '1', '0'])
      .default(fallback ? 'true' : 'false')
      .transform((value) => value === 'true' || value === '1'),
  );

/** URL http(s) opcional (endpoints dos emuladores; vazio = AWS real). */
const optionalHttpUrl = z.preprocess(
  blankToUndefined,
  z.url({ protocol: /^https?$/, error: 'inválida (esperado http://host:porta)' }).optional(),
);

/**
 * Janela do feed em horas (ADR 0005, FEED-03b). Ausente = 72. Presente, precisa ser um inteiro de
 * 1 a 720: `0`, `-1`, `abc` e vazio impedem a API de subir (sem o "vazio = ausente" das outras).
 */
const feedWindowHours = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) {
      return 72;
    }
    const hours = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
      ctx.addIssue({ code: 'custom', message: 'inválida (esperado um inteiro de 1 a 720 horas)' });
      return z.NEVER;
    }
    return hours;
  });

/** Segredo HMAC do JWT: pelo menos 32 caracteres (256 bits em base64url ≈ 43). */
const jwtSecret = z
  .string(required('um segredo aleatório'))
  .min(32, { error: 'curto demais (use ao menos 32 caracteres aleatórios)' });

/**
 * Variáveis de ambiente da API, validadas no boot (fase-0-plano.md §5).
 * Nada de default para URLs de banco e Redis nem para o segredo do JWT: faltou, o processo não sobe.
 */
export const ApiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_HOST: z.preprocess(blankToUndefined, z.string().default('0.0.0.0')),
    API_PORT: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(65_535).default(3000),
    ),
    /** Proxies confiáveis à frente da API (ALB = 1). Define o IP usado no rate limit. */
    TRUST_PROXY_HOPS: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
    DATABASE_URL: z.preprocess(
      blankToUndefined,
      z.url({
        protocol: /^postgres(ql)?$/,
        ...required('postgres://usuario:senha@host:5432/banco'),
      }),
    ),
    REDIS_URL: z.preprocess(
      blankToUndefined,
      z.url({ protocol: /^rediss?$/, ...required('redis://host:6379') }),
    ),

    // --- auth (ADR 0007) ---
    JWT_ACCESS_SECRET: z.preprocess(blankToUndefined, jwtSecret),
    /** `kid` do segredo atual, no cabeçalho do JWT. */
    JWT_ACCESS_KID: z.preprocess(blankToUndefined, z.string().min(1).default('k1')),
    /** Segredo anterior, aceito só na verificação durante uma rotação (opcional). */
    JWT_ACCESS_PREVIOUS_SECRET: z.preprocess(blankToUndefined, jwtSecret.optional()),
    JWT_ACCESS_PREVIOUS_KID: z.preprocess(blankToUndefined, z.string().min(1).optional()),
    ACCESS_TOKEN_TTL_S: positiveInt(15 * 60),
    REFRESH_TOKEN_TTL_S: positiveInt(30 * 24 * 60 * 60),
    /** Reapresentar um refresh já usado dentro desta janela é retry de rede, não roubo. */
    REFRESH_REUSE_GRACE_S: positiveInt(20),
    EMAIL_VERIFICATION_TTL_S: positiveInt(24 * 60 * 60),
    PASSWORD_RESET_TTL_S: positiveInt(60 * 60),

    // --- e-mail (D6) ---
    /** `log`: escreve o e-mail no log (dev e testes). `ses`: AWS SES (produção). */
    EMAIL_SENDER: z.preprocess(blankToUndefined, z.enum(['log', 'ses']).default('log')),
    EMAIL_FROM: z.preprocess(
      blankToUndefined,
      z.string().min(3).default('Sussurro <nao-responda@sussurro.app>'),
    ),
    /** Início dos links dos e-mails: o deep link do app (`sussurro://`) ou um domínio https. */
    EMAIL_LINK_BASE_URL: z.preprocess(blankToUndefined, z.url().default('sussurro://')),
    /**
     * Fila de moderação mínima (X.1, Fase 3): cada denúncia manda um e-mail para este endereço.
     * Obrigatória em produção; fora dela, vazia = `moderacao@example.com` (com `EMAIL_SENDER=log`,
     * o e-mail só aparece no log).
     */
    MODERATION_EMAIL: z.preprocess(
      blankToUndefined,
      z.email({ error: 'inválida (esperado um e-mail)' }).optional(),
    ),
    AWS_REGION: z.preprocess(blankToUndefined, z.string().min(1).default('sa-east-1')),

    // --- feed (ADR 0005) ---
    FEED_WINDOW_HOURS: feedWindowHours,

    // --- conexão presencial (Fase 4, ADR 0003; tempos por config, A-27) ---
    /** Validade do token de proximidade (`prox:t`): resolve e inicia pedido. */
    PROX_TOKEN_TTL_S: positiveInt(30),
    /** Janela "recente" do token (`prox:r`): ainda confirma um aceite (PROX-03). */
    PROX_RECENT_TTL_S: positiveInt(120),
    /** Prova de "tela Conectar aberta" (`prox:u`), renovada a cada token emitido. */
    PROX_SCREEN_TTL_S: positiveInt(30),
    /**
     * (ADR 0012, A2-2) Janela do casamento: o relato só casa com a observação do outro se o
     * **primeiro** relato dela tem menos que isto (5 s). A observação vive o dobro, sem renovar.
     */
    PROX_TOUCH_WINDOW_S: positiveInt(PROXIMITY_TOUCH_WINDOW_S),
    /**
     * (ADR 0012) Quanto tempo o par encostado (`prox:m`) vale para pedir a conexão por encostar e
     * (A2-2) quanto tempo o cartão devido espera a entrega.
     */
    PROX_TOUCH_PAIR_TTL_S: positiveInt(PROXIMITY_TOUCH_PAIR_TTL_S),
    /**
     * (ADR 0012, A2-1; decisão do PO) Teto de pessoas novas (pares criados) por conta, nos dois
     * lados do par: por hora e por dia, em janelas fixas. Acima dele, o encosto só não confirma. O
     * app não usa estes valores.
     */
    PROX_TOUCH_PAIRS_PER_HOUR: positiveInt(10),
    PROX_TOUCH_PAIRS_PER_DAY: positiveInt(30),
    /** Validade de um pedido de conexão pendente (PROX-15). */
    CONNECTION_REQUEST_TTL_S: positiveInt(120),
    /** Depois de uma recusa, A não pede de novo para B durante este tempo (PROX-17). */
    CONNECTION_DECLINE_COOLDOWN_S: positiveInt(60 * 60),
    /**
     * Onde ficam os tokens de proximidade: `redis` (Valkey; obrigatório em produção) ou `memory`
     * (só desenvolvimento sem Docker: memória do processo, uma instância, perdida ao reiniciar).
     */
    PROXIMITY_STORE: z.preprocess(blankToUndefined, z.enum(['redis', 'memory']).default('redis')),

    // --- mídia: S3, SQS e URLs assinadas (ADR 0009, infra.md §3.3) ---
    /** Endpoint do S3 para HEAD/Delete (SeaweedFS em dev). Vazio = AWS real. */
    AWS_ENDPOINT_URL_S3: optionalHttpUrl,
    /**
     * Endpoint que entra nas URLs pré-assinadas, usadas pelo celular (IP do PC na LAN em dev). O
     * host faz parte da assinatura. Vazio = o mesmo de `AWS_ENDPOINT_URL_S3`.
     */
    S3_PUBLIC_ENDPOINT_URL: optionalHttpUrl,
    S3_FORCE_PATH_STYLE: booleanFlag(false),
    S3_BUCKET_MEDIA: z.preprocess(blankToUndefined, z.string().min(3).default('sussurro-media')),
    /** Endpoint do SQS (ElasticMQ em dev). Vazio = AWS real. */
    AWS_ENDPOINT_URL_SQS: optionalHttpUrl,
    SQS_QUEUE_MEDIA_JOBS: z.preprocess(blankToUndefined, z.string().min(1).default('media-jobs')),
    /** Fila do push (Fase 6, ADR 0011): a API só envia ids; o worker monta e manda o push. */
    SQS_QUEUE_PUSH: z.preprocess(blankToUndefined, z.string().min(1).default('push')),
    /** Validade da URL PUT pré-assinada (10 min, ADR 0009). */
    PRESIGN_PUT_TTL_S: positiveInt(10 * 60),
    /**
     * Como a API assina as URLs de leitura da mídia: `s3-presign` (GET pré-assinado no S3; dev com
     * SeaweedFS, infra.md §3.3) ou `cloudfront` (produção, URL assinada do CloudFront).
     */
    MEDIA_URL_SIGNER: z.preprocess(
      blankToUndefined,
      z.enum(['s3-presign', 'cloudfront']).default('s3-presign'),
    ),
    /** Validade das URLs de leitura (6 h, A-19). */
    MEDIA_URL_TTL_S: positiveInt(6 * 60 * 60),
    CLOUDFRONT_DOMAIN: z.preprocess(blankToUndefined, z.string().min(3).optional()),
    CLOUDFRONT_KEY_PAIR_ID: z.preprocess(blankToUndefined, z.string().min(1).optional()),
    /** Chave privada RSA em PEM (as quebras de linha podem vir como `\n`). Secrets Manager. */
    CLOUDFRONT_PRIVATE_KEY: z.preprocess(
      blankToUndefined,
      z
        .string()
        .transform((value) => value.replace(/\\n/g, '\n'))
        .pipe(z.string().includes('PRIVATE KEY', { error: 'inválida (esperado um PEM)' }))
        .optional(),
    ),

    SENTRY_DSN: z.preprocess(blankToUndefined, z.url().optional()),
    SENTRY_ENVIRONMENT: z.preprocess(blankToUndefined, z.string().default('local')),
    SENTRY_TRACES_SAMPLE_RATE: z.preprocess(
      blankToUndefined,
      z.coerce.number().min(0).max(1).default(0),
    ),
    /** Release do Sentry (o CI passa o SHA, infra.md §4). Vazio = o SDK tenta descobrir. */
    SENTRY_RELEASE: z.preprocess(blankToUndefined, z.string().max(200).optional()),
    /**
     * Pontos de OpenTelemetry (6.8): desligados por padrão, sem exportador. Ligados, criam spans
     * pelo `@opentelemetry/api` (no-op sem SDK; com o Sentry com tracing, os spans vão para ele) e
     * propagam o `traceparent` na fila `push`.
     */
    OTEL_ENABLED: booleanFlag(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.EMAIL_SENDER === 'log') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_SENDER'],
        message: 'em produção use "ses" (o adaptador "log" escreve os links no log)',
      });
    }
    if (env.NODE_ENV === 'production' && env.MODERATION_EMAIL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['MODERATION_EMAIL'],
        message: 'obrigatória em produção (as denúncias vão para este e-mail)',
      });
    }
    if (env.NODE_ENV === 'production' && env.MEDIA_URL_SIGNER !== 'cloudfront') {
      ctx.addIssue({
        code: 'custom',
        path: ['MEDIA_URL_SIGNER'],
        message: 'em produção use "cloudfront" (a mídia só sai pelo CloudFront, ADR 0009)',
      });
    }
    if (env.NODE_ENV === 'production' && env.PROXIMITY_STORE !== 'redis') {
      ctx.addIssue({
        code: 'custom',
        path: ['PROXIMITY_STORE'],
        message: 'em produção use "redis" (o modo "memory" é só para desenvolvimento sem Docker)',
      });
    }
    if (env.PROX_RECENT_TTL_S < env.PROX_TOKEN_TTL_S) {
      ctx.addIssue({
        code: 'custom',
        path: ['PROX_RECENT_TTL_S'],
        message: 'precisa ser maior ou igual a PROX_TOKEN_TTL_S (o token recente inclui o válido)',
      });
    }
    // ADR 0012 §3: o token devolvido no casamento continua "recente" durante todo o par.
    if (env.PROX_TOUCH_PAIR_TTL_S + env.PROX_TOKEN_TTL_S > env.PROX_RECENT_TTL_S) {
      ctx.addIssue({
        code: 'custom',
        path: ['PROX_TOUCH_PAIR_TTL_S'],
        message:
          'PROX_TOUCH_PAIR_TTL_S + PROX_TOKEN_TTL_S precisa ser menor ou igual a PROX_RECENT_TTL_S (o token do casamento vale durante todo o par)',
      });
    }
    if (env.PROX_TOUCH_WINDOW_S > env.PROX_TOKEN_TTL_S) {
      ctx.addIssue({
        code: 'custom',
        path: ['PROX_TOUCH_WINDOW_S'],
        message:
          'precisa ser menor ou igual a PROX_TOKEN_TTL_S (a janela do encosto cabe na validade do token)',
      });
    }
    // A2-2: subir a janela sem um build novo do app quebraria a revelação simétrica em silêncio.
    if (env.PROX_TOUCH_WINDOW_S + TOUCH_REPORT_LATENCY_S > PROXIMITY_TOUCH_REPORT_FOR_S) {
      ctx.addIssue({
        code: 'custom',
        path: ['PROX_TOUCH_WINDOW_S'],
        message: `PROX_TOUCH_WINDOW_S + ${String(TOUCH_REPORT_LATENCY_S)} precisa ser menor ou igual a ${String(PROXIMITY_TOUCH_REPORT_FOR_S)} (o app relata por ${String(PROXIMITY_TOUCH_REPORT_FOR_S)} s; a revelação simétrica depende disso)`,
      });
    }
    if (env.PROX_TOUCH_PAIRS_PER_DAY < env.PROX_TOUCH_PAIRS_PER_HOUR) {
      ctx.addIssue({
        code: 'custom',
        path: ['PROX_TOUCH_PAIRS_PER_DAY'],
        message: 'precisa ser maior ou igual a PROX_TOUCH_PAIRS_PER_HOUR',
      });
    }
    if (env.MEDIA_URL_SIGNER === 'cloudfront') {
      for (const name of [
        'CLOUDFRONT_DOMAIN',
        'CLOUDFRONT_KEY_PAIR_ID',
        'CLOUDFRONT_PRIVATE_KEY',
      ] as const) {
        if (env[name] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'obrigatória com MEDIA_URL_SIGNER=cloudfront',
          });
        }
      }
    }
    const hasPreviousSecret = env.JWT_ACCESS_PREVIOUS_SECRET !== undefined;
    const hasPreviousKid = env.JWT_ACCESS_PREVIOUS_KID !== undefined;
    if (hasPreviousSecret !== hasPreviousKid) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_PREVIOUS_KID'],
        message: 'defina JWT_ACCESS_PREVIOUS_SECRET e JWT_ACCESS_PREVIOUS_KID juntos',
      });
    }
    if (hasPreviousKid && env.JWT_ACCESS_PREVIOUS_KID === env.JWT_ACCESS_KID) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_PREVIOUS_KID'],
        message: 'precisa ser diferente de JWT_ACCESS_KID',
      });
    }
  });

export type ApiEnv = z.infer<typeof ApiEnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Variáveis de ambiente inválidas:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/** Valida `process.env` (ou outra fonte). Lança `EnvValidationError` citando cada variável. */
export function loadApiEnv(source: Record<string, string | undefined>): ApiEnv {
  const result = ApiEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}
