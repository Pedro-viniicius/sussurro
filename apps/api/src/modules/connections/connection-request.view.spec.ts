import type { ConnectionRequestRow } from '@sussurro/db';
import { describe, expect, it } from 'vitest';

import { toConnectionRequestView, visibleStatus } from './connection-request.view.js';

const A = '01a189e0-af57-7000-85fe-2054e618fe0a';
const B = '01a189e0-af57-7000-85fe-2054e618fe0b';
const created = new Date('2026-10-29T12:00:00.000Z');

function row(status: ConnectionRequestRow['status']): ConnectionRequestRow {
  return {
    id: '01a189e0-af57-7000-85fe-2054e618fe99',
    fromId: A,
    fromType: 'personal',
    toId: B,
    toType: 'personal',
    status,
    method: 'qr',
    createdAt: created,
    expiresAt: new Date(created.getTime() + 120_000),
    respondedAt: status === 'pending' ? null : created,
  };
}

describe('estado do pedido visto por cada pessoa (ux.md §5.2)', () => {
  const now = new Date(created.getTime() + 10_000);
  const later = new Date(created.getTime() + 120_000);

  it('[PROX-17] quem pediu nunca distingue recusa, expiração e cancelamento ("não confirmado")', () => {
    expect(visibleStatus(row('pending'), A, now)).toBe('pending');
    expect(visibleStatus(row('accepted'), A, now)).toBe('accepted');
    for (const status of ['declined', 'expired', 'cancelled'] as const) {
      expect(visibleStatus(row(status), A, now)).toBe('not_confirmed');
    }
    expect(visibleStatus(row('pending'), A, later)).toBe('not_confirmed');
  });

  it('[PROX-15] quem recebeu vê o estado real; pendente vencido já é expired', () => {
    for (const status of ['pending', 'accepted', 'declined', 'expired', 'cancelled'] as const) {
      expect(visibleStatus(row(status), B, now)).toBe(status);
    }
    expect(visibleStatus(row('pending'), B, later)).toBe('expired');
  });

  it('view: direção, segundos restantes (0 fora de pending) e datas ISO', () => {
    const other = { handle: 'caio.r', name: 'Caio', avatarUrl: null };
    expect(toConnectionRequestView(row('pending'), A, other, now)).toEqual({
      id: row('pending').id,
      direction: 'outgoing',
      status: 'pending',
      method: 'qr',
      other,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + 120_000).toISOString(),
      expiresInS: 110,
    });
    expect(
      toConnectionRequestView(row('pending'), B, other, new Date(created.getTime() + 500)),
    ).toMatchObject({ direction: 'incoming', expiresInS: 120 });
    expect(toConnectionRequestView(row('accepted'), B, other, now).expiresInS).toBe(0);
  });
});
