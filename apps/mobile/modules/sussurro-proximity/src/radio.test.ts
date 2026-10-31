import { proximityTokenToServiceUuid } from '@sussurro/shared';

import { createFakeRadio } from './fake-radio';
import { createNativeRadio, createUnavailableRadio } from './radio';
import type {
  NativeCapabilities,
  NativeEvents,
  NativeSightingEvent,
  NativeSubscription,
  SussurroProximityNativeModule,
} from './SussurroProximity.types';

const TOKEN = 'AbCdEfGhIjKlMn-_';

const NATIVE_CAPS: NativeCapabilities = {
  bleSupported: true,
  bluetooth: 'on',
  permission: 'granted',
  canAskAgain: true,
  canAdvertise: true,
  locationServices: 'off',
  deviceModel: 'Pixel 9',
};

/** Módulo nativo falso: guarda as chamadas e deixa o teste emitir os eventos. */
function fakeNative() {
  const listeners: { [E in keyof NativeEvents]: Set<NativeEvents[E]> } = {
    onSighting: new Set(),
    onStateChange: new Set(),
    onError: new Set(),
  };
  const native = {
    getCapabilitiesAsync: jest.fn(() => Promise.resolve(NATIVE_CAPS)),
    requestPermissionAsync: jest.fn(() =>
      Promise.resolve({
        ...NATIVE_CAPS,
        bluetooth: 'off' as const,
        permission: 'denied' as const,
        canAskAgain: false,
      }),
    ),
    startAdvertisingAsync: jest.fn((_uuid: string, _txPower: string) => Promise.resolve()),
    stopAdvertisingAsync: jest.fn(() => Promise.resolve()),
    startScanAsync: jest.fn((_prefix: string, _minIntervalMs: number) => Promise.resolve()),
    stopScanAsync: jest.fn(() => Promise.resolve()),
    requestEnableBluetoothAsync: jest.fn(() => Promise.resolve(true)),
    setKeepScreenOnAsync: jest.fn((_enabled: boolean) => Promise.resolve()),
    addListener: <E extends keyof NativeEvents>(
      event: E,
      listener: NativeEvents[E],
    ): NativeSubscription => {
      (listeners[event] as Set<NativeEvents[E]>).add(listener);
      return {
        remove: () => {
          (listeners[event] as Set<NativeEvents[E]>).delete(listener);
        },
      };
    },
  } satisfies SussurroProximityNativeModule;
  /**
   * Emite um evento como o nativo. `extra` simula campos que o tipo não tem mais, como o `txPower`
   * de um dev build antigo (ADR 0012, adendo A1).
   */
  const emitUuid = (uuid: string, rssi: number, extra: Record<string, unknown> = {}) => {
    const event: NativeSightingEvent = { uuid, rssi, ...extra };
    for (const listener of listeners.onSighting) listener(event);
  };
  return { native, listeners, emitUuid };
}

describe('sussurro-proximity: rádio sobre o nativo (4.3, ADR 0012)', () => {
  it('4.3 CA6: anuncia o UUID de 128 bits com o prefixo e o token, e a varredura devolve o mesmo token e o RSSI', async () => {
    const { native, emitUuid } = fakeNative();
    const radio = createNativeRadio(native);
    const seen: unknown[] = [];
    radio.onSighting((sighting) => seen.push(sighting));

    await radio.startAdvertising(TOKEN, { txPower: 'high' });
    const uuid = native.startAdvertisingAsync.mock.calls[0]?.[0];
    expect(uuid).toMatch(/^53555353-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(uuid).toBe(proximityTokenToServiceUuid(TOKEN));
    // ADR 0012 §2 e A1: só a potência vai por parâmetro (sem o campo TX; o nativo não guarda limiar).
    expect(native.startAdvertisingAsync).toHaveBeenCalledWith(uuid, 'high');
    expect(native.startAdvertisingAsync.mock.calls[0]).toStrictEqual([uuid, 'high']);
    expect(native.startAdvertisingAsync.mock.calls[0]).toHaveLength(2);

    await radio.startScan({ minIntervalMs: 200 });
    expect(native.startScanAsync).toHaveBeenCalledWith('53555353', 200);

    // Ida e volta: o UUID visto (em maiúsculas no iOS) vira o mesmo token, só com o RSSI.
    emitUuid(String(uuid).toUpperCase(), -58);
    emitUuid(String(uuid), -71);
    expect(seen).toStrictEqual([
      { token: TOKEN, rssi: -58 },
      { token: TOKEN, rssi: -71 },
    ]);
  });

  it('PROX-44: o campo TX que um nativo antigo mande é descartado, e o anúncio continua valendo (vira exatamente {token, rssi})', () => {
    const { native, emitUuid } = fakeNative();
    const radio = createNativeRadio(native);
    const seen: unknown[] = [];
    radio.onSighting((sighting) => seen.push(sighting));

    const extras: Record<string, unknown>[] = [
      { txPower: -127 },
      { txPower: -100 },
      { txPower: -40 },
      { txPower: 20 },
      { txPower: 99 },
      // `Integer.MIN_VALUE`: o que o `ScanRecord.getTxPowerLevel()` devolve sem o campo.
      { txPower: -2_147_483_648 },
      { txPower: null },
      {},
    ];
    for (const extra of extras) emitUuid(proximityTokenToServiceUuid(TOKEN), -60, extra);

    // Nenhum é descartado, e nenhum leva o campo adiante.
    expect(seen).toHaveLength(extras.length);
    for (const sighting of seen) {
      expect(sighting).toStrictEqual({ token: TOKEN, rssi: -60 });
    }
  });

  it('4.3 CA6: UUID sem o prefixo, curto ou mal formado é ignorado; RSSI 127 (sem medida) também', () => {
    const { native, emitUuid } = fakeNative();
    const radio = createNativeRadio(native);
    const seen: unknown[] = [];
    radio.onSighting((sighting) => seen.push(sighting));

    emitUuid('0000180f-0000-1000-8000-00805f9b34fb', -50); // Battery Service de outro app
    emitUuid('180F', -50); // UUID curto
    emitUuid('53555353-zzzz', -50);
    emitUuid(proximityTokenToServiceUuid(TOKEN), 127);
    emitUuid(proximityTokenToServiceUuid(TOKEN), 3);
    emitUuid(proximityTokenToServiceUuid(TOKEN), -130);
    emitUuid(proximityTokenToServiceUuid(TOKEN), Number.NaN);
    expect(seen).toEqual([]);
  });

  it('token mal formado não vira anúncio (é bug do app, não vai para o nativo)', () => {
    const { native } = fakeNative();
    const radio = createNativeRadio(native);
    expect(() => radio.startAdvertising('curto', { txPower: 'low' })).toThrow(/mal formado/);
    expect(native.startAdvertisingAsync).not.toHaveBeenCalled();
  });

  it('capacidades vêm do nativo com available = true, a localização e o modelo; a inscrição pode ser removida', async () => {
    const { native, listeners } = fakeNative();
    const radio = createNativeRadio(native);
    await expect(radio.getCapabilities()).resolves.toEqual({ ...NATIVE_CAPS, available: true });
    await expect(radio.requestPermission()).resolves.toMatchObject({
      available: true,
      permission: 'denied',
      canAskAgain: false,
    });

    const states: string[] = [];
    const subscription = radio.onStateChange((state) => states.push(state));
    for (const listener of listeners.onStateChange) listener({ bluetooth: 'off' });
    subscription.remove();
    for (const listener of listeners.onStateChange) listener({ bluetooth: 'on' });
    expect(states).toEqual(['off']);
  });

  it('nativo antigo (sem os campos da ADR 0012): localização "not_required" e modelo vazio', async () => {
    const { native } = fakeNative();
    const { locationServices: _location, deviceModel: _model, ...old } = NATIVE_CAPS;
    native.getCapabilitiesAsync.mockResolvedValueOnce(old as NativeCapabilities);
    await expect(createNativeRadio(native).getCapabilities()).resolves.toMatchObject({
      locationServices: 'not_required',
      deviceModel: '',
    });
  });

  it('sem o módulo nativo (Expo Go, dev build antigo): indisponível, sem anunciar nem varrer', async () => {
    const radio = createUnavailableRadio();
    await expect(radio.getCapabilities()).resolves.toMatchObject({
      available: false,
      bleSupported: false,
      canAdvertise: false,
    });
    await expect(radio.startAdvertising(TOKEN, { txPower: 'high' })).rejects.toThrow(
      /indisponível/,
    );
    await expect(radio.startScan({ minIntervalMs: 200 })).rejects.toThrow(/indisponível/);
    await expect(radio.stopScan()).resolves.toBeUndefined();
  });

  it('rádio falso: ligar a varredura já ligada não conta como novo início (como o nativo)', async () => {
    const radio = createFakeRadio();
    await radio.startScan({ minIntervalMs: 200 });
    await radio.startScan({ minIntervalMs: 300 });
    expect(radio.scanStarts).toBe(1);
    expect(radio.scanMinIntervalMs).toBe(300);
    await radio.stopScan();
    await radio.startScan({ minIntervalMs: 200 });
    expect(radio.scanStarts).toBe(2);
  });
});
