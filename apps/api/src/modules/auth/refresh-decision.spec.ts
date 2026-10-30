import { describe, expect, it } from 'vitest';

import { decideRefresh, type PresentedRefreshToken } from './refresh-decision.js';

const now = new Date('2026-10-29T12:00:00.000Z');
const grace = 20_000;

function token(overrides: Partial<PresentedRefreshToken> = {}): PresentedRefreshToken {
  return {
    usedAt: null,
    revokedAt: null,
    expiresAt: new Date(now.getTime() + 60_000),
    userDeletedAt: null,
    ...overrides,
  };
}

describe('decideRefresh (ADR 0007)', () => {
  it('[AUTH-08] nunca usado → rotate', () => {
    expect(decideRefresh(token(), now, grace)).toBe('rotate');
  });

  it('[AUTH-08] usado há até 20 s → retry; há mais de 20 s → reuse', () => {
    expect(decideRefresh(token({ usedAt: new Date(now.getTime() - 20_000) }), now, grace)).toBe(
      'retry',
    );
    expect(decideRefresh(token({ usedAt: new Date(now.getTime() - 20_001) }), now, grace)).toBe(
      'reuse',
    );
  });

  it('[AUTH-09] inexistente, revogado, vencido ou de conta excluída → invalid', () => {
    expect(decideRefresh(undefined, now, grace)).toBe('invalid');
    expect(decideRefresh(token({ revokedAt: now }), now, grace)).toBe('invalid');
    expect(decideRefresh(token({ expiresAt: now }), now, grace)).toBe('invalid');
    expect(decideRefresh(token({ userDeletedAt: now }), now, grace)).toBe('invalid');
    // Revogado tem prioridade sobre "usado": um token de família revogada nunca vira retry.
    expect(decideRefresh(token({ usedAt: now, revokedAt: now }), now, grace)).toBe('invalid');
  });
});
