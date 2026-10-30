import { proximityTokenToServiceUuid } from '@sussurro/shared';

import { createNativeRadio, createUnavailableRadio } from './radio';
import type {
  NativeEvents,
  NativeSubscription,
  SussurroProximityNativeModule,
} from './SussurroProximity.types';

const TOKEN = 'AbCdEfGhIjKlMn-_';

/** Módulo nativo falso: guarda as chamadas e deixa o teste emitir os eventos. */
function fakeNative() {
  const listeners: { [E in keyof NativeEvents]: Set<NativeEvents[E]> } = {
    onSighting: new Set(),
    onStateChange: new Set(),
    onError: new Set(),
  };
  const native = {
    getCapabilitiesAsync: jest.fn(() =>
      Promise.resolve({
        bleSupported: true,
        bluetooth: 'on' as const,
        permission: 'granted' as const,
        canAskAgain: true,
        canAdvertise: true,
      }),
    ),
    requestPermissionAsync: jest.fn(() =>
      Promise.resolve({
        bleSupported: true,
        bluetooth: 'off' as const,
        permission: 'denied' as const,
        canAskAgain: false,
        canAdvertise: true,
      }),
    ),
    startAdvertisingAsync: jest.fn((_uuid: string) => Promise.resolve()),
    stopAdvertisingAsync: jest.fn(() => Promise.resolve()),
    startScanAsync: jest.fn((_prefix: string) => Promise.resolve()),
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
  const emitUuid = (uuid: string, rssi: number) => {
    for (const listener of listeners.onSighting) listener({ uuid, rssi });
  };
  return { native, listeners, emitUuid };
}

describe('sussurro-proximity: rádio sobre o nativo (4.3)', () => {
  it('4.3 CA6: anuncia o UUID de 128 bits com o prefixo e o token, e a varredura devolve o mesmo token', async () => {
    const { native, emitUuid } = fakeNative();
    const radio = createNativeRadio(native);
    const seen: { token: string; rssi: number }[] = [];
    radio.onSighting((sighting) => seen.push(sighting));

    await radio.startAdvertising(TOKEN);
    const uuid = native.startAdvertisingAsync.mock.calls[0]?.[0];
    expect(uuid).toMatch(/^53555353-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(uuid).toBe(proximityTokenToServiceUuid(TOKEN));

    await radio.startScan();
    expect(native.startScanAsync).toHaveBeenCalledWith('53555353');

    // Ida e volta: o UUID visto (em maiúsculas no iOS) vira o mesmo token, com o RSSI.
    emitUuid(String(uuid).toUpperCase(), -58);
    emitUuid(String(uuid), -71);
    expect(seen).toEqual([
      { token: TOKEN, rssi: -58 },
      { token: TOKEN, rssi: -71 },
    ]);
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
    emitUuid(proximityTokenToServiceUuid(TOKEN), Number.NaN);
    expect(seen).toEqual([]);
  });

  it('token mal formado não vira anúncio (é bug do app, não vai para o nativo)', () => {
    const { native } = fakeNative();
    const radio = createNativeRadio(native);
    expect(() => radio.startAdvertising('curto')).toThrow(/mal formado/);
    expect(native.startAdvertisingAsync).not.toHaveBeenCalled();
  });

  it('capacidades vêm do nativo com available = true; a inscrição pode ser removida', async () => {
    const { native, listeners } = fakeNative();
    const radio = createNativeRadio(native);
    await expect(radio.getCapabilities()).resolves.toMatchObject({
      available: true,
      bluetooth: 'on',
      permission: 'granted',
    });
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

  it('sem o módulo nativo (Expo Go, dev build antigo): indisponível, sem anunciar nem varrer', async () => {
    const radio = createUnavailableRadio();
    await expect(radio.getCapabilities()).resolves.toMatchObject({
      available: false,
      bleSupported: false,
    });
    await expect(radio.startAdvertising(TOKEN)).rejects.toThrow(/indisponível/);
    await expect(radio.startScan()).rejects.toThrow(/indisponível/);
    await expect(radio.stopScan()).resolves.toBeUndefined();
  });
});
