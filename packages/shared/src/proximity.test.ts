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
  PROXIMITY_RECENT_TTL_S,
  PROXIMITY_RESOLVE_MAX_TOKENS,
  PROXIMITY_TOKEN_LENGTH,
  PROXIMITY_TOKEN_TTL_S,
  PROXIMITY_TOUCH_LIMIT_PER_MIN,
  PROXIMITY_TOUCH_MAX_TOKENS,
  PROXIMITY_TOUCH_PAIR_TTL_S,
  PROXIMITY_TOUCH_REPORT_FOR_S,
  PROXIMITY_TOUCH_REPORT_INTERVAL_S,
  PROXIMITY_TOUCH_WINDOW_S,
  ProximityResolveRequestSchema,
  ProximityResolveResultSchema,
  ProximityTokenSchema,
  ProximityTokenValueSchema,
  ProximityTouchItemSchema,
  ProximityTouchRequestSchema,
  ProximityTouchResultSchema,
  proximityQrPayload,
  proximityTokenToServiceUuid,
  serviceUuidToProximityToken,
  SimulatedTouchSchema,
  SimulateTouchRequestSchema,
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

  it('[PROX-22] pedido exige targetToken e method ble|qr; aceite com observedToken opcional (ADR 0012)', () => {
    expect(
      CreateConnectionRequestSchema.safeParse({ targetToken: token(), method: 'qr' }).success,
    ).toBe(true);
    expect(
      CreateConnectionRequestSchema.safeParse({ targetToken: token(), method: 'nfc' }).success,
    ).toBe(false);
    expect(CreateConnectionRequestSchema.safeParse({ targetToken: token() }).success).toBe(false);
    expect(
      CreateConnectionRequestSchema.safeParse({ targetToken: token(), method: 'ble', rssi: -40 })
        .success,
    ).toBe(false);
    // O aceite `ble` dispensa o token; o `qr` o exige pela regra do serviço (400 VALIDATION_ERROR).
    expect(AcceptConnectionRequestSchema.safeParse({}).success).toBe(true);
    expect(AcceptConnectionRequestSchema.safeParse({ observedToken: token() }).success).toBe(true);
    expect(AcceptConnectionRequestSchema.safeParse({ observedToken: 'curto' }).success).toBe(false);
    expect(
      AcceptConnectionRequestSchema.safeParse({ observedToken: token(), rssi: -40 }).success,
    ).toBe(false);
    expect(SimulateConnectionRequestSchema.safeParse({}).success).toBe(true);
    expect(SimulateConnectionRequestSchema.safeParse({ from: 'lucasf', x: 1 }).success).toBe(false);
  });

  it('[PROX-01] a emissão traz dois tokens (bleToken e qrToken), sem o campo antigo `token`', () => {
    const issued = {
      bleToken: token(),
      qrToken: token(),
      expiresAt: '2026-10-30T12:00:30.000Z',
      renewInS: 20,
    };
    expect(ProximityTokenSchema.parse(issued)).toEqual(issued);
    expect(ProximityTokenSchema.safeParse({ ...issued, qrToken: undefined }).success).toBe(false);
    expect(ProximityTokenSchema.safeParse({ ...issued, bleToken: 'curto' }).success).toBe(false);
    // O interceptor da API descarta campos fora do schema: nada além dos quatro sai na resposta.
    expect(Object.keys(ProximityTokenSchema.parse({ ...issued, token: token() })).sort()).toEqual([
      'bleToken',
      'expiresAt',
      'qrToken',
      'renewInS',
    ]);
  });
});

describe('encostar (ADR 0012 §3 e Adendo A2)', () => {
  it('[PROX-38] touches aceita exatamente 1 token (A2-1); 0 ou 2 e qualquer campo a mais (rssi, txPower, modelo) → recusado', () => {
    expect(PROXIMITY_TOUCH_MAX_TOKENS).toBe(1);
    expect(ProximityTouchRequestSchema.safeParse({ tokens: [token()] }).success).toBe(true);
    expect(ProximityTouchRequestSchema.safeParse({ tokens: [] }).success).toBe(false);
    expect(ProximityTouchRequestSchema.safeParse({ tokens: [token(), token()] }).success).toBe(
      false,
    );
    expect(ProximityTouchRequestSchema.safeParse({ tokens: token() }).success).toBe(false);
    expect(ProximityTouchRequestSchema.safeParse({ tokens: ['curto'] }).success).toBe(false);
    expect(ProximityTouchRequestSchema.safeParse({}).success).toBe(false);
    for (const extra of [
      { rssi: -40 },
      { txPower: -21 },
      { model: 'Pixel 9' },
      { loss: 35 },
      { tokens: [token()], at: 1 },
    ]) {
      expect(ProximityTouchRequestSchema.safeParse({ tokens: [token()], ...extra }).success).toBe(
        false,
      );
    }
  });

  it('[PROX-32] a resposta é sempre {items} de cartões; vazia quando não há encosto mútuo', () => {
    expect(ProximityTouchResultSchema.safeParse({ items: [] }).success).toBe(true);
    const card = {
      token: token(),
      handle: 'bia.alves',
      name: 'Bia Alves',
      avatarUrl: null,
      alreadyConnected: false,
      pairExpiresInS: 60,
    };
    expect(ProximityTouchResultSchema.parse({ items: [card] })).toEqual({ items: [card] });
  });

  it('[PROX-64] cada cartão do touches traz pairExpiresInS, inteiro ≥ 0 e obrigatório; o cartão do QR (resolve) não', () => {
    const person = {
      token: token(),
      handle: 'bia.alves',
      name: 'Bia Alves',
      avatarUrl: null,
      alreadyConnected: false,
    };
    for (const seconds of [0, 1, 43, 60]) {
      expect(ProximityTouchItemSchema.parse({ ...person, pairExpiresInS: seconds })).toEqual({
        ...person,
        pairExpiresInS: seconds,
      });
    }
    for (const invalid of [-1, 1.5, '60', null, undefined]) {
      expect(
        ProximityTouchResultSchema.safeParse({ items: [{ ...person, pairExpiresInS: invalid }] })
          .success,
      ).toBe(false);
    }
    // O QR não tem par: a resposta do resolve continua sem o campo (o interceptor o descartaria).
    expect(
      Object.keys(
        ProximityResolveResultSchema.parse({ items: [{ ...person, pairExpiresInS: 60 }] })
          .items[0]!,
      ),
    ).not.toContain('pairExpiresInS');
  });

  it('[PROX-47] tempos padrão: janela de 5 s, par de 60 s, relato a cada 1 s por 8 s; par + validade cabem no "recente"; janela + 2 s cabem no relato', () => {
    expect(PROXIMITY_TOUCH_WINDOW_S).toBe(5);
    expect(PROXIMITY_TOUCH_PAIR_TTL_S).toBe(60);
    expect(PROXIMITY_TOUCH_REPORT_INTERVAL_S).toBe(1);
    expect(PROXIMITY_TOUCH_REPORT_FOR_S).toBe(8);
    expect(PROXIMITY_TOUCH_PAIR_TTL_S + PROXIMITY_TOKEN_TTL_S).toBeLessThanOrEqual(
      PROXIMITY_RECENT_TTL_S,
    );
    expect(PROXIMITY_TOUCH_WINDOW_S).toBeLessThanOrEqual(PROXIMITY_TOKEN_TTL_S);
    // A2-2: quem foi visto relata de novo depois do último casamento possível (latência de 2 s).
    expect(PROXIMITY_TOUCH_WINDOW_S + 2).toBeLessThanOrEqual(PROXIMITY_TOUCH_REPORT_FOR_S);
  });

  it('[PROX-34] [PROX-59] limite de 60 relatos por minuto no servidor (A2 rev. 1): cabe um relato por segundo, e o prazo de um encosto inteiro cabe com folga', () => {
    expect(PROXIMITY_TOUCH_LIMIT_PER_MIN).toBe(60);
    expect(Number.isInteger(PROXIMITY_TOUCH_LIMIT_PER_MIN)).toBe(true);
    // Um relato por segundo durante um minuto inteiro não passa do limite.
    expect(60 / PROXIMITY_TOUCH_REPORT_INTERVAL_S).toBeLessThanOrEqual(
      PROXIMITY_TOUCH_LIMIT_PER_MIN,
    );
    // R1-3: os relatos de um prazo aberto (8 s, um por segundo, mais o que o abriu) cabem em 2/3.
    expect(
      Math.ceil(PROXIMITY_TOUCH_REPORT_FOR_S / PROXIMITY_TOUCH_REPORT_INTERVAL_S) + 1,
    ).toBeLessThanOrEqual(Math.floor((PROXIMITY_TOUCH_LIMIT_PER_MIN * 2) / 3));
  });

  it('[PROX-42] simulate-touch: persona opcional, sem campo a mais; devolve só o bleToken', () => {
    expect(SimulateTouchRequestSchema.safeParse({}).success).toBe(true);
    expect(SimulateTouchRequestSchema.safeParse({ from: 'tomas' }).success).toBe(true);
    expect(SimulateTouchRequestSchema.safeParse({ from: '' }).success).toBe(false);
    expect(SimulateTouchRequestSchema.safeParse({ from: 'tomas', rssi: -40 }).success).toBe(false);
    const value = token();
    expect(SimulatedTouchSchema.parse({ bleToken: value, qrToken: token() })).toEqual({
      bleToken: value,
    });
  });
});

describe('QR code (D3, D7)', () => {
  it('[PROX-24] payload sussurro://c/{qrToken}; ida e volta devolvem o qrToken', () => {
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
