import { requireOptionalNativeModule } from 'expo';

import { createFakeNfc, IPHONE_NFC_CAPABILITIES } from './fake-nfc';
import {
  createNativeNfc,
  createUnavailableNfc,
  getNfc,
  NATIVE_MODULE_NAME,
  resetNfcForTests,
} from './nfc';
import type {
  NativeNfcCapabilities,
  NfcEventName,
  NfcEvents,
  NfcSubscription,
  SussurroProximityNativeModule,
} from './SussurroProximity.types';

jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn() }));

const requireNative = jest.mocked(requireOptionalNativeModule);

const TOKEN = 'AbCdEfGhIjKlMn-_';
const URI = `sussurro://c/${TOKEN}`;

const NATIVE_CAPS: NativeNfcCapabilities = {
  supported: true,
  enabled: false,
  canEmit: true,
  canRead: true,
};

/** Módulo nativo falso: guarda as chamadas e deixa o teste emitir os eventos crus. */
function fakeNative() {
  const listeners: Record<NfcEventName, Set<(event: unknown) => void>> = {
    onNfcRead: new Set(),
    onNfcReadError: new Set(),
    onNfcStateChange: new Set(),
  };
  const native = {
    getNfcCapabilities: jest.fn(() => Promise.resolve(NATIVE_CAPS)),
    setEmittedPayload: jest.fn((_uri: string | null) => undefined),
    startReading: jest.fn(() => Promise.resolve()),
    stopReading: jest.fn(() => undefined),
    openNfcSettings: jest.fn(() => undefined),
    addListener: <E extends NfcEventName>(event: E, listener: NfcEvents[E]): NfcSubscription => {
      const wrapped = listener as (event: unknown) => void;
      listeners[event].add(wrapped);
      return {
        remove: () => {
          listeners[event].delete(wrapped);
        },
      };
    },
  } satisfies SussurroProximityNativeModule;
  const emit = (event: NfcEventName, body: unknown) => {
    for (const listener of listeners[event]) listener(body);
  };
  return { native, listeners, emit };
}

describe('sussurro-proximity: NFC sobre o nativo (ADR 0013 §4)', () => {
  it('NFC-18: capacidades vêm do nativo com available = true', async () => {
    const { native } = fakeNative();
    await expect(createNativeNfc(native).getNfcCapabilities()).resolves.toStrictEqual({
      available: true,
      supported: true,
      enabled: false,
      canEmit: true,
      canRead: true,
    });
  });

  it('NFC-18: campo ausente de um nativo diferente vira false', async () => {
    const { native } = fakeNative();
    native.getNfcCapabilities.mockResolvedValueOnce({ supported: true } as NativeNfcCapabilities);
    await expect(createNativeNfc(native).getNfcCapabilities()).resolves.toStrictEqual({
      available: true,
      supported: true,
      enabled: false,
      canEmit: false,
      canRead: false,
    });
  });

  it('NFC-18 / NFC-16: emite o código e apaga com null; código mal formado lança e não chega ao nativo', () => {
    const { native } = fakeNative();
    const nfc = createNativeNfc(native);
    nfc.setEmittedPayload(URI);
    nfc.setEmittedPayload(null);
    expect(native.setEmittedPayload.mock.calls).toStrictEqual([[URI], [null]]);

    for (const bad of ['https://evil.example/c/x', 'sussurro://c/curto', ` ${URI}`, '']) {
      expect(() => {
        nfc.setEmittedPayload(bad);
      }).toThrow(/mal formado/);
    }
    expect(native.setEmittedPayload).toHaveBeenCalledTimes(2);
  });

  it('NFC-16 (N2): só repassa onNfcRead com o prefixo sussurro://c/ e token bem formado', () => {
    const { native, emit } = fakeNative();
    const nfc = createNativeNfc(native);
    const seen: unknown[] = [];
    nfc.addListener('onNfcRead', (event) => {
      seen.push(event);
    });

    emit('onNfcRead', { uri: URI });
    emit('onNfcRead', { uri: 'https://outro.app/x' });
    emit('onNfcRead', { uri: 'sussurro://c/curto' });
    emit('onNfcRead', { uri: 'sussurro://c/AbCdEfGhIjKlMn-_extra' });
    emit('onNfcRead', { uri: 42 });
    emit('onNfcRead', {});
    expect(seen).toStrictEqual([{ uri: URI }]);
  });

  it('NFC-18: erro de leitura conhecido passa; desconhecido vira read_failed', () => {
    const { native, emit } = fakeNative();
    const nfc = createNativeNfc(native);
    const codes: string[] = [];
    nfc.addListener('onNfcReadError', ({ code }) => codes.push(code));
    for (const code of ['cancelled', 'timeout', 'unsupported', 'disabled', 'read_failed']) {
      emit('onNfcReadError', { code });
    }
    emit('onNfcReadError', { code: 'tag_lost' });
    expect(codes).toStrictEqual([
      'cancelled',
      'timeout',
      'unsupported',
      'disabled',
      'read_failed',
      'read_failed',
    ]);
  });

  it('NFC-18: onNfcStateChange chega como boolean e a inscrição pode ser removida', () => {
    const { native, emit, listeners } = fakeNative();
    const nfc = createNativeNfc(native);
    const states: boolean[] = [];
    const subscription = nfc.addListener('onNfcStateChange', ({ enabled }) => states.push(enabled));
    emit('onNfcStateChange', { enabled: false });
    emit('onNfcStateChange', { enabled: true });
    subscription.remove();
    emit('onNfcStateChange', { enabled: false });
    expect(states).toStrictEqual([false, true]);
    expect(listeners.onNfcStateChange.size).toBe(0);
  });

  it('NFC-18: leitura e Ajustes vão direto ao nativo', async () => {
    const { native } = fakeNative();
    const nfc = createNativeNfc(native);
    await nfc.startReading();
    nfc.stopReading();
    nfc.openNfcSettings();
    expect(native.startReading).toHaveBeenCalledTimes(1);
    expect(native.stopReading).toHaveBeenCalledTimes(1);
    expect(native.openNfcSettings).toHaveBeenCalledTimes(1);
  });

  it('NFC-18: erro do nativo ao começar a ler rejeita a promise', async () => {
    const { native } = fakeNative();
    native.startReading.mockRejectedValueOnce(new Error('ERR_NFC_DISABLED'));
    await expect(createNativeNfc(native).startReading()).rejects.toThrow('ERR_NFC_DISABLED');
  });
});

describe('sussurro-proximity: NFC indisponível', () => {
  it('NFC-18 (Expo Go): sem o módulo nativo: tudo false, ler rejeita, o resto não faz nada', async () => {
    const nfc = createUnavailableNfc();
    await expect(nfc.getNfcCapabilities()).resolves.toStrictEqual({
      available: false,
      supported: false,
      enabled: false,
      canEmit: false,
      canRead: false,
    });
    await expect(nfc.startReading()).rejects.toThrow(/indisponível/);
    expect(() => {
      nfc.setEmittedPayload(URI);
      nfc.setEmittedPayload(null);
      nfc.stopReading();
      nfc.openNfcSettings();
      nfc.addListener('onNfcRead', () => undefined).remove();
    }).not.toThrow();
  });
});

describe('sussurro-proximity: getNfc', () => {
  beforeEach(() => {
    resetNfcForTests();
    requireNative.mockReset();
  });

  it('NFC-18: sem o nativo no build (Expo Go): devolve o indisponível', async () => {
    requireNative.mockReturnValue(null);
    await expect(getNfc().getNfcCapabilities()).resolves.toMatchObject({ available: false });
    expect(requireNative).toHaveBeenCalledWith(NATIVE_MODULE_NAME);
  });

  it('NFC-18: com o nativo: usa o módulo e guarda a mesma instância', async () => {
    const { native } = fakeNative();
    requireNative.mockReturnValue(native);
    const nfc = getNfc();
    expect(getNfc()).toBe(nfc);
    expect(requireNative).toHaveBeenCalledTimes(1);
    await expect(nfc.getNfcCapabilities()).resolves.toMatchObject({ available: true });
  });
});

describe('sussurro-proximity: NFC falso', () => {
  it('NFC-19: guarda o código emitido, e no iPhone (canEmit false) não emite', () => {
    const android = createFakeNfc();
    android.setEmittedPayload(URI);
    expect(android.emitted).toBe(URI);
    android.setEmittedPayload(null);
    expect(android.emitted).toBeNull();
    expect(android.emittedHistory).toStrictEqual([URI, null]);

    const iphone = createFakeNfc(IPHONE_NFC_CAPABILITIES);
    iphone.setEmittedPayload(URI);
    expect(iphone.emitted).toBeNull();
  });

  it('NFC-19: leitura simulada só chega enquanto lê; cancelar encerra a leitura', async () => {
    const nfc = createFakeNfc();
    const seen: string[] = [];
    const errors: string[] = [];
    nfc.addListener('onNfcRead', ({ uri }) => seen.push(uri));
    nfc.addListener('onNfcReadError', ({ code }) => errors.push(code));

    nfc.simulateRead(URI);
    expect(seen).toStrictEqual([]);

    await nfc.startReading();
    expect(nfc.reading).toBe(true);
    nfc.simulateRead(URI);
    expect(seen).toStrictEqual([URI]);

    nfc.simulateReadError('cancelled');
    expect(errors).toStrictEqual(['cancelled']);
    expect(nfc.reading).toBe(false);
    expect(nfc.readStarts).toBe(1);
  });

  it('NFC-19: NFC desligado nos Ajustes: avisa, atualiza as capacidades e para a leitura', async () => {
    const nfc = createFakeNfc();
    const states: boolean[] = [];
    const subscription = nfc.addListener('onNfcStateChange', ({ enabled }) => states.push(enabled));
    await nfc.startReading();
    nfc.simulateStateChange(false);
    expect(states).toStrictEqual([false]);
    expect(nfc.reading).toBe(false);
    await expect(nfc.getNfcCapabilities()).resolves.toMatchObject({ enabled: false });
    subscription.remove();
    expect(nfc.listenerCount('onNfcStateChange')).toBe(0);
  });

  it('NFC-19: startReading pode falhar uma vez, e sem o módulo sempre falha', async () => {
    const nfc = createFakeNfc();
    nfc.failNextStart = new Error('ERR_NFC_DISABLED');
    await expect(nfc.startReading()).rejects.toThrow('ERR_NFC_DISABLED');
    await expect(nfc.startReading()).resolves.toBeUndefined();

    const missing = createFakeNfc({ available: false });
    await expect(missing.startReading()).rejects.toThrow(/indisponível/);
    missing.openNfcSettings();
    expect(missing.settingsOpened).toBe(1);
  });
});
