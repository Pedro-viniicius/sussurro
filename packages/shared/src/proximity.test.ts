import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AcceptConnectionRequestSchema,
  CreateConnectionRequestSchema,
  SimulateConnectionRequestSchema,
} from './connections.ts';
import {
  parseProximityQr,
  PROXIMITY_RECENT_TTL_S,
  PROXIMITY_RENEW_INTERVAL_S,
  PROXIMITY_RESOLVE_MAX_TOKENS,
  PROXIMITY_TOKEN_ISSUE_LIMIT_PER_MIN,
  PROXIMITY_TOKEN_LENGTH,
  PROXIMITY_TOKEN_TTL_S,
  ProximityResolveRequestSchema,
  ProximityTokenSchema,
  ProximityTokenValueSchema,
  proximityQrPayload,
} from './proximity.ts';
import * as proximity from './proximity.ts';

/** Token como o servidor gera: 12 bytes aleatórios em base64url. */
function token(): string {
  return randomBytes(12).toString('base64url');
}

describe('token de proximidade (ADR 0003)', () => {
  it('[PROX-01] 12 bytes em base64url = 16 caracteres; o schema aceita só esse formato', () => {
    for (let index = 0; index < 50; index++) {
      const value = token();
      expect(value).toHaveLength(PROXIMITY_TOKEN_LENGTH);
      expect(ProximityTokenValueSchema.safeParse(value).success).toBe(true);
    }
    for (const invalid of [
      '',
      'curto',
      'a'.repeat(17),
      'abcdefghijklmno=',
      'abcdefghijklmn+/',
      'ação-ação-ação-a',
    ]) {
      expect(ProximityTokenValueSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('[PROX-05] resolve aceita de 1 a 20 tokens, sem campos a mais (sem RSSI)', () => {
    expect(ProximityResolveRequestSchema.safeParse({ tokens: [token()] }).success).toBe(true);
    expect(ProximityResolveRequestSchema.safeParse({ tokens: [] }).success).toBe(false);
    const many = Array.from({ length: PROXIMITY_RESOLVE_MAX_TOKENS + 1 }, token);
    expect(ProximityResolveRequestSchema.safeParse({ tokens: many }).success).toBe(false);
    expect(ProximityResolveRequestSchema.safeParse({ tokens: [token()], rssi: -60 }).success).toBe(
      false,
    );
  });

  it('[PROX-22] pedido exige targetToken e method qr|nfc; aceite exige observedToken nos dois (ADR 0013)', () => {
    for (const method of ['qr', 'nfc']) {
      expect(
        CreateConnectionRequestSchema.safeParse({ targetToken: token(), method }).success,
      ).toBe(true);
    }
    for (const method of ['ble', 'QR', '', undefined]) {
      expect(
        CreateConnectionRequestSchema.safeParse({ targetToken: token(), method }).success,
      ).toBe(false);
    }
    expect(
      CreateConnectionRequestSchema.safeParse({ targetToken: token(), method: 'nfc', rssi: -40 })
        .success,
    ).toBe(false);
    // D7: o aceite sempre traz o token lido de quem pediu (sem ele → 400 VALIDATION_ERROR).
    expect(AcceptConnectionRequestSchema.safeParse({}).success).toBe(false);
    expect(AcceptConnectionRequestSchema.safeParse({ observedToken: token() }).success).toBe(true);
    expect(AcceptConnectionRequestSchema.safeParse({ observedToken: 'curto' }).success).toBe(false);
    expect(
      AcceptConnectionRequestSchema.safeParse({ observedToken: token(), rssi: -40 }).success,
    ).toBe(false);
    expect(SimulateConnectionRequestSchema.safeParse({}).success).toBe(true);
    expect(SimulateConnectionRequestSchema.safeParse({ method: 'nfc' }).success).toBe(true);
    expect(SimulateConnectionRequestSchema.safeParse({ method: 'ble' }).success).toBe(false);
    expect(SimulateConnectionRequestSchema.safeParse({ from: 'lucasf', x: 1 }).success).toBe(false);
  });

  it('[PROX-01] a emissão traz um token só (ADR 0013), a validade e quando renovar', () => {
    const issued = { token: token(), expiresAt: '2026-10-30T12:00:30.000Z', renewInS: 20 };
    expect(ProximityTokenSchema.parse(issued)).toEqual(issued);
    expect(ProximityTokenSchema.safeParse({ ...issued, token: undefined }).success).toBe(false);
    expect(ProximityTokenSchema.safeParse({ ...issued, token: 'curto' }).success).toBe(false);
    // O interceptor da API descarta campos fora do schema: os antigos bleToken/qrToken não saem.
    expect(
      Object.keys(
        ProximityTokenSchema.parse({ ...issued, bleToken: token(), qrToken: token() }),
      ).sort(),
    ).toEqual(['expiresAt', 'renewInS', 'token']);
  });

  it('[PROX-25] tempos padrão: 30 s válido, 120 s recente, renovação a cada 20 s', () => {
    expect(PROXIMITY_TOKEN_TTL_S).toBe(30);
    expect(PROXIMITY_RECENT_TTL_S).toBe(120);
    expect(PROXIMITY_RENEW_INTERVAL_S).toBe(20);
    expect(PROXIMITY_RENEW_INTERVAL_S).toBeLessThan(PROXIMITY_TOKEN_TTL_S);
  });

  it('[PROX-20] [PROX-68] limite de 6 emissões por minuto no servidor: a rotação de 20 s gasta 3 e sobram outras 3 para reabrir a tela', () => {
    expect(PROXIMITY_TOKEN_ISSUE_LIMIT_PER_MIN).toBe(6);
    expect(Number.isInteger(PROXIMITY_TOKEN_ISSUE_LIMIT_PER_MIN)).toBe(true);
    // A tela aberta por 60 s: uma emissão a cada 20 s, a primeira ao abrir.
    const rotationsPerMinute = 60 / PROXIMITY_RENEW_INTERVAL_S;
    expect(rotationsPerMinute).toBe(3);
    expect(rotationsPerMinute * 2).toBeLessThanOrEqual(PROXIMITY_TOKEN_ISSUE_LIMIT_PER_MIN);
  });

  it('(ADR 0013) nada do encosto por Bluetooth sobra no contrato', () => {
    const names = Object.keys(proximity);
    expect(names.filter((name) => /touch|ble|uuid/i.test(name))).toEqual([]);
  });
});

describe('código do QR e do NFC (D3, D7, ADR 0013)', () => {
  it('[PROX-24] payload sussurro://c/{token}, o mesmo no QR e no NFC; ida e volta devolvem o token', () => {
    const value = token();
    expect(proximityQrPayload(value)).toBe(`sussurro://c/${value}`);
    expect(parseProximityQr(proximityQrPayload(value))).toBe(value);
    expect(parseProximityQr(` ${proximityQrPayload(value)}\n`)).toBe(value);
  });

  it('[PROX-24] código de outro app, adulterado ou com token mal formado → null', () => {
    const value = token();
    expect(parseProximityQr(`https://exemplo.com/c/${value}`)).toBeNull();
    expect(parseProximityQr(`sussurro://c/${value}x`)).toBeNull();
    expect(parseProximityQr('sussurro://c/')).toBeNull();
    expect(parseProximityQr('sussurro://u/helena')).toBeNull();
  });
});
