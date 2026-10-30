import { z } from 'zod';

/** Trata `VAR=` (vazia no .env) como ausente. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const required = (what: string) => ({
  error: (issue: { input?: unknown }) =>
    issue.input === undefined ? 'obrigatória' : `inválida (esperado ${what})`,
});

/** Inteiro com mínimo e padrão. */
const intWithDefault = (min: number, fallback: number, max?: number) =>
  z.preprocess(
    blankToUndefined,
    (max === undefined
      ? z.coerce.number().int().min(min)
      : z.coerce.number().int().min(min).max(max)
    ).default(fallback),
  );

/** URL http(s) opcional (endpoints dos emuladores; vazio = AWS real). */
const optionalHttpUrl = z.preprocess(
  blankToUndefined,
  z.url({ protocol: /^https?$/, error: 'inválida (esperado http://host:porta)' }).optional(),
);

/**
 * Variáveis de ambiente do worker. Postgres e Redis já são obrigatórios: os consumidores de
 * fila da Fase 2 gravam no banco, e o processo não deve subir pela metade.
 */
export const WorkerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.preprocess(
    blankToUndefined,
    z.url({ protocol: /^postgres(ql)?$/, ...required('postgres://usuario:senha@host:5432/banco') }),
  ),
  REDIS_URL: z.preprocess(
    blankToUndefined,
    z.url({ protocol: /^rediss?$/, ...required('redis://host:6379') }),
  ),
  SENTRY_DSN: z.preprocess(blankToUndefined, z.url().optional()),
  SENTRY_ENVIRONMENT: z.preprocess(blankToUndefined, z.string().default('local')),
  SENTRY_TRACES_SAMPLE_RATE: z.preprocess(
    blankToUndefined,
    z.coerce.number().min(0).max(1).default(0),
  ),
  /** Release do Sentry (o CI passa o SHA). Vazio = o SDK tenta descobrir. */
  SENTRY_RELEASE: z.preprocess(blankToUndefined, z.string().max(200).optional()),
  /** Pontos de OpenTelemetry (6.8): desligados por padrão, sem exportador. */
  OTEL_ENABLED: z.preprocess(
    blankToUndefined,
    z
      .enum(['true', 'false', '1', '0'])
      .default('false')
      .transform((value) => value === 'true' || value === '1'),
  ),
  /** Dias entre a exclusão da conta (deleted_at) e o hard delete (arquitetura.md §15). */
  ACCOUNT_PURGE_AFTER_DAYS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).max(30).default(30),
  ),
  /**
   * Intervalo do job de manutenção: hard delete, tokens vencidos e, desde a Fase 2, a limpeza de
   * rascunhos, posts apagados e uploads de avatar (2.11).
   */
  MAINTENANCE_INTERVAL_MS: z.preprocess(
    blankToUndefined,
    z.coerce
      .number()
      .int()
      .min(1_000)
      .default(60 * 60 * 1000),
  ),

  // --- mídia (Fase 2, ADR 0009) ---
  AWS_REGION: z.preprocess(blankToUndefined, z.string().min(1).default('sa-east-1')),
  /** Endpoint do S3 (SeaweedFS em dev). Vazio = AWS real. */
  AWS_ENDPOINT_URL_S3: optionalHttpUrl,
  S3_FORCE_PATH_STYLE: z.preprocess(
    blankToUndefined,
    z
      .enum(['true', 'false', '1', '0'])
      .default('false')
      .transform((value) => value === 'true' || value === '1'),
  ),
  S3_BUCKET_MEDIA: z.preprocess(blankToUndefined, z.string().min(3).default('sussurro-media')),
  /** Endpoint do SQS (ElasticMQ em dev). Vazio = AWS real. */
  AWS_ENDPOINT_URL_SQS: optionalHttpUrl,
  SQS_QUEUE_MEDIA_JOBS: z.preprocess(blankToUndefined, z.string().min(1).default('media-jobs')),
  /** Mensagens processadas ao mesmo tempo (cada imagem decodificada ocupa memória). */
  MEDIA_JOBS_CONCURRENCY: intWithDefault(1, 2, 10),
  /** Long polling do SQS (0 a 20 s). */
  MEDIA_JOBS_WAIT_S: intWithDefault(0, 20, 20),
  /**
   * Tentativas por mensagem: igual ao `maxReceiveCount` da DLQ (infra/local/elasticmq.conf). Na
   * última, a imagem vira `failed` e a mensagem segue para a DLQ.
   */
  MEDIA_JOBS_MAX_ATTEMPTS: intWithDefault(1, 3, 10),
  /** Teto de pixels decodificados (MID-06): bomba de descompressão vira `failed`. */
  MEDIA_MAX_INPUT_PIXELS: intWithDefault(1_000_000, 40_000_000),
  /** Rascunhos mais velhos que isto são apagados com os objetos (2.11, MID-12). */
  DRAFT_TTL_HOURS: intWithDefault(1, 24),
  /**
   * Mídia em `processing` há mais que isto vira `failed` (worker caiu nas 3 tentativas; no vídeo,
   * também o evento do MediaConvert que nunca chegou).
   */
  MEDIA_PROCESSING_TIMEOUT_MIN: intWithDefault(5, 60),

  // --- vídeo dos reels (Fase 5, ADR 0006) ---
  /**
   * `passthrough` (dev e testes: copia o vídeo e usa o poster do app; **mantém os metadados do
   * original**, por isso é recusado em produção) ou `mediaconvert` (AWS MediaConvert). Outro valor
   * impede o worker de subir (5.1 CA2).
   */
  VIDEO_PROCESSOR: z.preprocess(
    blankToUndefined,
    z
      .enum(['passthrough', 'mediaconvert'], {
        error: 'inválida (esperado passthrough ou mediaconvert)',
      })
      .default('passthrough'),
  ),
  /** Role de serviço do MediaConvert (lê `incoming/*`, grava `media/*`); obrigatória com ele. */
  MEDIACONVERT_ROLE_ARN: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^arn:aws[\w-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/, {
        error: 'inválida (esperado arn:aws:iam::123456789012:role/nome)',
      })
      .optional(),
  ),
  /** Fila do MediaConvert (opcional; vazio = a fila `Default` da conta). */
  MEDIACONVERT_QUEUE_ARN: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^arn:aws[\w-]*:mediaconvert:[\w-]+:\d{12}:queues\/[\w-]+$/, {
        error: 'inválida (esperado arn:aws:mediaconvert:região:conta:queues/nome)',
      })
      .optional(),
  ),
  /** Fila dos eventos de fim de job do MediaConvert (EventBridge → SQS). */
  SQS_QUEUE_VIDEO_EVENTS: z.preprocess(blankToUndefined, z.string().min(1).default('video-events')),

  // --- push (Fase 6, ADR 0011) ---
  /** Fila `push`: a API manda só ids; o worker monta o texto curto e envia ao Expo. */
  SQS_QUEUE_PUSH: z.preprocess(blankToUndefined, z.string().min(1).default('push')),
  /**
   * `expo` (Expo Push Service; obrigatório em produção) ou `log` (dev e testes: escreve no log o
   * texto e o token mascarado, sem sair da máquina). Outro valor impede o worker de subir.
   */
  PUSH_SENDER: z.preprocess(
    blankToUndefined,
    z.enum(['log', 'expo'], { error: 'inválida (esperado log ou expo)' }).default('log'),
  ),
  /**
   * Access token do Expo, se a "segurança reforçada" de push estiver ligada no projeto do Expo.
   * Segredo (Secrets Manager em produção); nunca no repositório.
   */
  EXPO_ACCESS_TOKEN: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  /** Mensagens de push processadas por rodada (até 10, o máximo do SQS por chamada). */
  PUSH_JOBS_CONCURRENCY: intWithDefault(1, 10, 10),
  /** Tentativas por mensagem: igual ao `maxReceiveCount` da `push-dlq`. */
  PUSH_JOBS_MAX_ATTEMPTS: intWithDefault(1, 3, 10),
  /** Intervalo da consulta dos recibos do Expo (os recibos ficam prontos em cerca de 15 min). */
  PUSH_RECEIPTS_INTERVAL_MS: z.preprocess(
    blankToUndefined,
    z.coerce
      .number()
      .int()
      .min(1_000)
      .default(15 * 60 * 1000),
  ),
});

/**
 * Regras que dependem de mais de uma variável (5.1, ADR 0006, A-21): o passthrough copia o vídeo
 * com a localização do original e nunca roda em produção; o MediaConvert precisa da role.
 */
const WorkerEnvRulesSchema = WorkerEnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.VIDEO_PROCESSOR !== 'mediaconvert') {
    ctx.addIssue({
      code: 'custom',
      path: ['VIDEO_PROCESSOR'],
      message: 'em produção, só mediaconvert (o passthrough mantém a localização do vídeo)',
    });
  }
  if (env.NODE_ENV === 'production' && env.PUSH_SENDER !== 'expo') {
    ctx.addIssue({
      code: 'custom',
      path: ['PUSH_SENDER'],
      message: 'em produção, só expo (o modo log escreve o texto do push no log)',
    });
  }
  if (env.VIDEO_PROCESSOR === 'mediaconvert' && env.MEDIACONVERT_ROLE_ARN === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['MEDIACONVERT_ROLE_ARN'],
      message: 'obrigatória com VIDEO_PROCESSOR=mediaconvert',
    });
  }
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Variáveis de ambiente inválidas:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

export function loadWorkerEnv(source: Record<string, string | undefined>): WorkerEnv {
  const result = WorkerEnvRulesSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}
