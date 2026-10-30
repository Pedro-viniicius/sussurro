import { z } from 'zod';

import { countChars, isBlankText, normalizeText } from './text.ts';

/**
 * Motivos da denúncia (X.1): lista curta e fechada, a mesma do enum `report_reason` do banco. A
 * ordem é a da tela.
 */
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'violence',
  'sexual',
  'self_harm',
  'impersonation',
  'other',
] as const;
export const ReportReasonSchema = z.enum(REPORT_REASONS, { error: 'Escolha um motivo.' });
export type ReportReason = z.infer<typeof ReportReasonSchema>;

/** Rótulos em pt-BR para a tela de denúncia (Fase 3b). */
export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = {
  spam: 'Spam ou golpe',
  harassment: 'Assédio ou bullying',
  hate: 'Discurso de ódio',
  violence: 'Violência ou ameaça',
  sexual: 'Nudez ou conteúdo sexual',
  self_harm: 'Suicídio ou automutilação',
  impersonation: 'Perfil falso ou se passando por outra pessoa',
  other: 'Outro motivo',
};

/** Texto opcional da denúncia: até 500 caracteres (mesma contagem dos comentários). */
export const REPORT_DETAILS_MAX_LENGTH = 500;

/** Detalhes: vazio, só espaços ou ausente vira `null`. */
export const ReportDetailsSchema = z
  .union([
    z.null(),
    z
      .string()
      .max(5_000, { error: `Use no máximo ${REPORT_DETAILS_MAX_LENGTH} caracteres.` })
      .transform(normalizeText)
      .refine((value) => countChars(value) <= REPORT_DETAILS_MAX_LENGTH, {
        error: `Use no máximo ${REPORT_DETAILS_MAX_LENGTH} caracteres.`,
      })
      .transform((value) => (isBlankText(value) ? null : value.trim())),
  ])
  .optional()
  .transform((value) => value ?? null);

/**
 * O que está sendo denunciado: uma publicação ou um comentário (pelo id) ou uma conta (pelo @).
 * Algo que a pessoa não vê (ou não existe) → 404 igual ao de inexistente.
 */
export const ReportTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('post'), id: z.uuid({ error: 'Identificador inválido.' }) }),
  z.strictObject({ type: z.literal('comment'), id: z.uuid({ error: 'Identificador inválido.' }) }),
  z.strictObject({ type: z.literal('account'), handle: z.string().min(1).max(64) }),
]);
export type ReportTarget = z.infer<typeof ReportTargetSchema>;

/**
 * `POST /reports` (X.1, qualquer tipo de conta) → 202 sem corpo. A pessoa denunciada nunca é
 * avisada; repetir a denúncia do mesmo alvo devolve o mesmo 202 sem duplicar nada.
 */
export const CreateReportRequestSchema = z.strictObject({
  target: ReportTargetSchema,
  reason: ReportReasonSchema,
  details: ReportDetailsSchema,
});
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;
export type CreateReportInput = z.input<typeof CreateReportRequestSchema>;
