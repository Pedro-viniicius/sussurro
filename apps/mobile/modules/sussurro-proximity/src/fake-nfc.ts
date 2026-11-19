import type {
  Nfc,
  NfcCapabilities,
  NfcEventName,
  NfcEvents,
  NfcReadErrorCode,
  NfcSubscription,
} from './SussurroProximity.types';

/** Um Android com NFC ligado e HCE: emite e lê. */
export const READY_NFC_CAPABILITIES: NfcCapabilities = {
  available: true,
  supported: true,
  enabled: true,
  canEmit: true,
  canRead: true,
};

/** Um iPhone com NFC: só lê, pela folha do sistema. */
export const IPHONE_NFC_CAPABILITIES: NfcCapabilities = {
  available: true,
  supported: true,
  enabled: true,
  canEmit: false,
  canRead: true,
};

export interface FakeNfc extends Nfc {
  /** O que `getNfcCapabilities` devolve agora (mutável nos testes). */
  capabilities: NfcCapabilities;
  /** Código emitido agora (`null` = sem emissão). */
  emitted: string | null;
  /** Todos os valores passados a `setEmittedPayload`, em ordem (inclusive os `null`). */
  emittedHistory: (string | null)[];
  reading: boolean;
  /** Quantas vezes `startReading` foi chamado. */
  readStarts: number;
  settingsOpened: number;
  /** Faz o próximo `startReading` rejeitar com este erro. */
  failNextStart: Error | null;
  /** Simula um código lido por NFC (só chega se estiver lendo, como no nativo). */
  simulateRead: (uri: string) => void;
  /** Simula um erro de leitura; `cancelled` e `timeout` encerram a leitura, como no iPhone. */
  simulateReadError: (code: NfcReadErrorCode) => void;
  /** Simula o NFC ligado ou desligado nos Ajustes (desligar para a leitura). */
  simulateStateChange: (enabled: boolean) => void;
  /** Quantos ouvintes estão inscritos no evento. */
  listenerCount: (event: NfcEventName) => number;
}

/**
 * NFC em memória para os testes (e para simular sem aparelho): guarda o que foi emitido e deixa o
 * teste "encostar" outro aparelho. Fica fora do índice do módulo para não entrar no bundle.
 */
export function createFakeNfc(capabilities: Partial<NfcCapabilities> = {}): FakeNfc {
  const listeners: { [E in NfcEventName]: Set<NfcEvents[E]> } = {
    onNfcRead: new Set(),
    onNfcReadError: new Set(),
    onNfcStateChange: new Set(),
  };

  function addListener<E extends NfcEventName>(event: E, listener: NfcEvents[E]): NfcSubscription {
    const set = listeners[event] as Set<NfcEvents[E]>;
    set.add(listener);
    return {
      remove: () => {
        set.delete(listener);
      },
    };
  }

  const nfc: FakeNfc = {
    capabilities: { ...READY_NFC_CAPABILITIES, ...capabilities },
    emitted: null,
    emittedHistory: [],
    reading: false,
    readStarts: 0,
    settingsOpened: 0,
    failNextStart: null,
    getNfcCapabilities: () => Promise.resolve({ ...nfc.capabilities }),
    setEmittedPayload: (uri) => {
      nfc.emitted = nfc.capabilities.canEmit ? uri : null;
      nfc.emittedHistory.push(uri);
    },
    startReading: () => {
      if (nfc.failNextStart !== null) {
        const error = nfc.failNextStart;
        nfc.failNextStart = null;
        return Promise.reject(error);
      }
      if (!nfc.capabilities.available) {
        return Promise.reject(new Error('NFC indisponível neste build.'));
      }
      nfc.readStarts += 1;
      nfc.reading = true;
      return Promise.resolve();
    },
    stopReading: () => {
      nfc.reading = false;
    },
    openNfcSettings: () => {
      nfc.settingsOpened += 1;
    },
    addListener,
    simulateRead: (uri) => {
      if (!nfc.reading) return;
      for (const listener of [...listeners.onNfcRead]) listener({ uri });
    },
    simulateReadError: (code) => {
      if (code === 'cancelled' || code === 'timeout') nfc.reading = false;
      for (const listener of [...listeners.onNfcReadError]) listener({ code });
    },
    simulateStateChange: (enabled) => {
      nfc.capabilities = { ...nfc.capabilities, enabled };
      if (!enabled) nfc.reading = false;
      for (const listener of [...listeners.onNfcStateChange]) listener({ enabled });
    },
    listenerCount: (event) => listeners[event].size,
  };
  return nfc;
}
