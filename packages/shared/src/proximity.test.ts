import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AcceptConnectionRequestSchema,
  CreateConnectionRequestSchema,
  SimulateConnectionRequestSchema,
} from './connections.ts';
import {
  BLE_SERVICE_UUID_PREFIX,
  parseProximityQr,
  PROXIMITY_RESOLVE_MAX_TOKENS,
  PROXIMITY_TOKEN_LENGTH,
  ProximityResolveRequestSchema,
  ProximityTokenValueSchema,
  proximityQrPayload,
  proximityTokenToServiceUuid,
  serviceUuidToProximityToken,
} from './proximity.ts';

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

  it('[PROX-22] pedido exige targetToken e method ble|qr; aceite exige observedToken', () => {
    expect(
      CreateConnectionRequestSchema.safeParse({ targetToken: token(), method: 'qr' }).success,
    ).toBe(true);
    expect(
      CreateConnectionRequestSchema.safeParse({ targetToken: token(), method: 'nfc' }).success,
    ).toBe(false);
    expect(CreateConnectionRequestSchema.safeParse({ targetToken: token() }).success).toBe(false);
    expect(AcceptConnectionRequestSchema.safeParse({}).success).toBe(false);
    expect(AcceptConnectionRequestSchema.safeParse({ observedToken: token() }).success).toBe(true);
    expect(SimulateConnectionRequestSchema.safeParse({}).success).toBe(true);
    expect(SimulateConnectionRequestSchema.safeParse({ from: 'lucasf', x: 1 }).success).toBe(false);
  });
});

describe('QR code (D3, D7)', () => {
  it('[PROX-24] payload sussurro://c/{token}; ida e volta devolvem o token', () => {
    const value = token();
    expect(proximityQrPayload(value)).toBe(`sussurro://c/${value}`);
    expect(parseProximityQr(proximityQrPayload(value))).toBe(value);
    expect(parseProximityQr(` ${proximityQrPayload(value)}\n`)).toBe(value);
  });

  it('[PROX-24] QR de outro app, adulterado ou com token mal formado → null', () => {
    const value = token();
    expect(parseProximityQr(`https://exemplo.com/c/${value}`)).toBeNull();
    expect(parseProximityQr(`sussurro://c/${value}x`)).toBeNull();
    expect(parseProximityQr('sussurro://c/')).toBeNull();
    expect(parseProximityQr('sussurro://u/helena')).toBeNull();
  });
});

describe('UUID do anúncio BLE (ADR 0002, 4.3 CA6)', () => {
  it('prefixo fixo de 4 bytes + 12 bytes do token, em UUID canônico; ida e volta dão o mesmo token', () => {
    for (let index = 0; index < 200; index++) {
      const value = token();
      const uuid = proximityTokenToServiceUuid(value);
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(uuid.startsWith(BLE_SERVICE_UUID_PREFIX)).toBe(true);
      expect(serviceUuidToProximityToken(uuid)).toBe(value);
      expect(serviceUuidToProximityToken(uuid.toUpperCase())).toBe(value);
      expect(serviceUuidToProximityToken(uuid.replace(/-/g, ''))).toBe(value);
    }
  });

  it('os bytes do UUID são exatamente os do token (mesma conta que o Buffer do Node)', () => {
    const bytes = randomBytes(12);
    const uuid = proximityTokenToServiceUuid(bytes.toString('base64url'));
    expect(uuid.replace(/-/g, '')).toBe(`${BLE_SERVICE_UUID_PREFIX}${bytes.toString('hex')}`);
  });

  it('UUID sem o prefixo, curto ou mal formado é ignorado (null)', () => {
    expect(serviceUuidToProximityToken('0000180f-0000-1000-8000-00805f9b34fb')).toBeNull();
    expect(serviceUuidToProximityToken('180f')).toBeNull();
    expect(serviceUuidToProximityToken('53555353-zzzz-0000-0000-000000000000')).toBeNull();
    expect(serviceUuidToProximityToken('')).toBeNull();
  });

  it('token mal formado não vira UUID (erro do app, não do anúncio)', () => {
    expect(() => proximityTokenToServiceUuid('curto')).toThrow();
  });
});
