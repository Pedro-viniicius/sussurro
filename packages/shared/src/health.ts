import { z } from 'zod';

/** `GET /health` (liveness): não depende de Postgres nem de Redis. */
export const HealthLiveSchema = z.object({
  status: z.literal('ok'),
});

export type HealthLive = z.infer<typeof HealthLiveSchema>;

export const DependencyStatusSchema = z.enum(['up', 'down']);

export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;

export const DependencyCheckSchema = z.object({
  status: DependencyStatusSchema,
  /** Duração da verificação, em milissegundos. */
  latencyMs: z.number().int().nonnegative(),
});

export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;

/** `GET /health/ready` (readiness): 200 com tudo `up`, 503 com qualquer `down`. */
export const HealthReadySchema = z.object({
  status: z.enum(['ok', 'error']),
  checks: z.object({
    postgres: DependencyCheckSchema,
    redis: DependencyCheckSchema,
  }),
});

export type HealthReady = z.infer<typeof HealthReadySchema>;
