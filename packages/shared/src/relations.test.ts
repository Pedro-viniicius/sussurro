import { describe, expect, it } from 'vitest';

import { BlockRequestSchema, OwnListQuerySchema } from './relations.ts';
import {
  CreateReportRequestSchema,
  REPORT_REASON_LABELS,
  REPORT_REASONS,
  ReportDetailsSchema,
} from './reports.ts';

describe('listas próprias (3.6)', () => {
  it('[PERM-08] ?userId=, ?handle= e qualquer outro parâmetro → recusados', () => {
    expect(OwnListQuerySchema.safeParse({}).success).toBe(true);
    expect(OwnListQuerySchema.parse({ limit: '100' })).toEqual({ limit: 50 });
    for (const extra of [{ userId: 'x' }, { handle: 'helena' }, { user: 'x' }, { id: '1' }]) {
      expect(OwnListQuerySchema.safeParse(extra).success).toBe(false);
    }
  });
});

describe('bloquear (X.2)', () => {
  it('pelo @ ou pelo comentário; os dois juntos, nenhum ou campo a mais → recusado', () => {
    expect(BlockRequestSchema.safeParse({ handle: 'helena' }).success).toBe(true);
    expect(
      BlockRequestSchema.safeParse({ commentId: '01a189e0-af57-7000-85fe-2054e618fea6' }).success,
    ).toBe(true);
    for (const body of [
      {},
      { handle: '' },
      { commentId: 'nao-e-uuid' },
      { handle: 'helena', commentId: '01a189e0-af57-7000-85fe-2054e618fea6' },
      { handle: 'helena', userId: 'x' },
    ]) {
      expect(BlockRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('denunciar (X.1)', () => {
  const id = '01a189e0-af57-7000-85fe-2054e618fea6';

  it('motivo da lista curta, com rótulo em pt-BR para cada um', () => {
    expect(REPORT_REASONS).toHaveLength(8);
    for (const reason of REPORT_REASONS) {
      expect(REPORT_REASON_LABELS[reason].length).toBeGreaterThan(0);
    }
    expect(
      CreateReportRequestSchema.safeParse({ target: { type: 'post', id }, reason: 'outro' })
        .success,
    ).toBe(false);
  });

  it('alvo: post ou comentário pelo id, conta pelo @; nada além disso', () => {
    for (const target of [
      { type: 'post', id },
      { type: 'comment', id },
      { type: 'account', handle: 'helena' },
    ]) {
      expect(CreateReportRequestSchema.safeParse({ target, reason: 'spam' }).success).toBe(true);
    }
    for (const target of [
      { type: 'post', handle: 'helena' },
      { type: 'account', id },
      { type: 'user', id },
      { type: 'post', id: 'x' },
    ]) {
      expect(CreateReportRequestSchema.safeParse({ target, reason: 'spam' }).success).toBe(false);
    }
    expect(
      CreateReportRequestSchema.safeParse({
        target: { type: 'post', id },
        reason: 'spam',
        reporterId: id,
      }).success,
    ).toBe(false);
  });

  it('detalhes opcionais até 500 (code points); vazio ou só espaços vira null', () => {
    expect(ReportDetailsSchema.parse(undefined)).toBeNull();
    expect(ReportDetailsSchema.parse('   ')).toBeNull();
    expect(ReportDetailsSchema.parse(' Ofensivo. ')).toBe('Ofensivo.');
    expect(ReportDetailsSchema.safeParse('😀'.repeat(500)).success).toBe(true);
    expect(ReportDetailsSchema.safeParse('a'.repeat(501)).success).toBe(false);
  });
});
