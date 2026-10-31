import { REPORT_REASON_LABELS, type ReportReason } from '@sussurro/shared';

import type { EmailMessage } from '../../infra/email/email-sender.js';
import type { ProximityAbuseRole } from '../proximity/proximity.service.js';

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

export interface ProximityAbuseSignal {
  /** @ da conta sinalizada (nunca o da outra parte). */
  accountHandle: string;
  role: ProximityAbuseRole;
  detectedAt: Date;
}

/** O verbo do papel e a coluna da tabela `blocks` em que a moderação confere (A2 rev. 1, R1-6). */
const ABUSE_ROLES: Readonly<Record<ProximityAbuseRole, { verb: string; column: string }>> = {
  blocker: { verb: 'fez', column: 'blocker_id' },
  blocked: { verb: 'recebeu', column: 'blocked_id' },
};

/**
 * E-mail do sinal de abuso do Conectar (ADR 0012, A2-3; texto da A2 rev. 1, R1-6): uma conta fez
 * (ou recebeu) 3 bloqueios até 60 s depois de um encosto, nos últimos 7 dias. O contador conta
 * bloqueios, não pessoas (no máximo um por encosto e por sentido; os 3 podem ser da mesma pessoa em
 * encostos diferentes), então o e-mail manda conferir a tabela `blocks`. Minimização: só o @ da
 * conta e o papel; sem o @ da outra parte, sem ids e sem horários de encosto. Nenhuma ação
 * automática: pessoas combinadas podem gerar o sinal contra alguém, e a moderação avalia.
 */
export function proximityAbuseEmail(to: string, signal: ProximityAbuseSignal): EmailMessage {
  const { verb, column } = ABUSE_ROLES[signal.role];
  const handle = `@${signal.accountHandle}`;
  return {
    to,
    subject: `Sinal no Conectar: ${handle} ${verb} 3 bloqueios logo depois de encostar`,
    text: [
      'Sinal de possível abuso no Conectar (encostar os celulares).',
      '',
      `Conta: ${handle}`,
      `Sinal: ${verb} 3 bloqueios até 60 s depois de um encosto, nos últimos 7 dias.`,
      'Cada encosto conta no máximo um bloqueio em cada sentido, mas os 3 podem envolver a mesma pessoa, em encostos diferentes.',
      `Detectado em: ${signal.detectedAt.toISOString()}`,
      '',
      `Para saber quantas pessoas: na tabela blocks, as linhas dos últimos 7 dias com ${column} igual ao id de ${handle}. Um desbloqueio apaga a linha, então pode haver menos linhas do que bloqueios.`,
      '',
      'Nenhuma ação automática foi tomada. Pessoas combinadas, ou uma só pessoa em encostos repetidos, podem gerar este sinal contra alguém: avalie antes de agir.',
    ].join('\n'),
  };
}
