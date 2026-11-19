import { REPORT_REASON_LABELS, type ReportReason } from '@sussurro/shared';

import type { EmailMessage } from '../../infra/email/email-sender.js';

export type ReportedTargetType = 'post' | 'comment' | 'account';

export interface ReportedTarget {
  type: ReportedTargetType;
  /** Id do post ou do comentário (ausente na denúncia de conta). */
  contentId?: string;
  /** @ da conta denunciada ou da autora do conteúdo. */
  accountHandle: string;
}

export interface ModerationReport {
  id: string;
  target: ReportedTarget;
  reason: ReportReason;
  details: string | null;
  createdAt: Date;
}

const TARGET_LABELS: Readonly<Record<ReportedTargetType, string>> = {
  post: 'publicação',
  comment: 'comentário',
  account: 'conta',
};

/**
 * E-mail da fila de moderação mínima (X.1): um por denúncia nova, para `MODERATION_EMAIL`.
 * Minimização: só o id da denúncia, o alvo (id e @), o motivo e o texto de quem denunciou. O
 * conteúdo denunciado e a identidade de quem denunciou ficam no banco (consulta pelo id).
 */
export function moderationEmail(to: string, report: ModerationReport): EmailMessage {
  const target = report.target;
  const what =
    target.contentId === undefined
      ? `conta @${target.accountHandle}`
      : `${TARGET_LABELS[target.type]} ${target.contentId} de @${target.accountHandle}`;
  return {
    to,
    subject: `Denúncia de ${TARGET_LABELS[target.type]}: ${REPORT_REASON_LABELS[report.reason]} (${report.id})`,
    text: [
      'Nova denúncia no Sussurro.',
      '',
      `Denúncia: ${report.id}`,
      `Alvo: ${what}`,
      `Motivo: ${REPORT_REASON_LABELS[report.reason]}`,
      `Detalhes: ${report.details ?? '(sem detalhes)'}`,
      `Recebida em: ${report.createdAt.toISOString()}`,
      '',
      'A pessoa denunciada não é avisada. Quem denunciou fica registrado no banco (tabela reports).',
    ].join('\n'),
  };
}
