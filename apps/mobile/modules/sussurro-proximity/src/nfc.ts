import { parseProximityQr } from '@sussurro/shared';
import { requireOptionalNativeModule } from 'expo';

import type {
  NativeNfcCapabilities,
  Nfc,
  NfcCapabilities,
  NfcEventName,
  NfcEvents,
  NfcReadErrorCode,
  NfcSubscription,
  SussurroProximityNativeModule,
} from './SussurroProximity.types';

/** Nome do módulo nos dois nativos (`Name("SussurroProximity")`). */
export const NATIVE_MODULE_NAME = 'SussurroProximity';

const READ_ERROR_CODES: readonly NfcReadErrorCode[] = [
  'cancelled',
  'timeout',
  'unsupported',
  'disabled',
  'read_failed',
];

/** Código desconhecido (nativo mais novo ou mais velho que o JS) vira `read_failed`. */
function normalizeErrorCode(code: unknown): NfcReadErrorCode {
  return READ_ERROR_CODES.includes(code as NfcReadErrorCode)
    ? (code as NfcReadErrorCode)
    : 'read_failed';
}

/** Só aceita emitir um código do Sussurro bem formado: outra coisa é bug do app. */
function assertEmittable(uri: string | null): void {
  if (uri !== null && (uri !== uri.trim() || parseProximityQr(uri) === null)) {
    throw new Error('Código de conexão mal formado: não vai para o NFC.');
  }
}

const NOOP_SUBSCRIPTION: NfcSubscription = { remove: () => undefined };

/**
 * O NFC sobre o módulo nativo. O nativo já filtra pelo formato exato (`sussurro://c/` + 16); aqui o código
 * passa de novo pelo `parseProximityQr` (token bem formado), e o que não passar não chega à tela
 * (ADR 0013 §6, N2: outro app pode responder ao mesmo AID NDEF).
 */
export function createNativeNfc(native: SussurroProximityNativeModule): Nfc {
  function addListener<E extends NfcEventName>(event: E, listener: NfcEvents[E]): NfcSubscription {
    switch (event) {
      case 'onNfcRead': {
        const onRead = listener as NfcEvents['onNfcRead'];
        return native.addListener('onNfcRead', ({ uri }) => {
          if (typeof uri === 'string' && parseProximityQr(uri) !== null) {
            onRead({ uri: uri.trim() });
          }
        });
      }
      case 'onNfcReadError': {
        const onError = listener as NfcEvents['onNfcReadError'];
        return native.addListener('onNfcReadError', ({ code }) => {
          onError({ code: normalizeErrorCode(code) });
        });
      }
      case 'onNfcStateChange': {
        const onState = listener as NfcEvents['onNfcStateChange'];
        return native.addListener('onNfcStateChange', (event) => {
          // O evento cruza a ponte sem tipo: só `true` conta como ligado.
          const { enabled } = event as { enabled?: unknown };
          onState({ enabled: enabled === true });
        });
      }
      default:
        return NOOP_SUBSCRIPTION;
    }
  }

  return {
    getNfcCapabilities: async () => {
      // Vem do nativo sem tipo: campo ausente ou estranho (build diferente do JS) vira `false`.
      const caps = (await native.getNfcCapabilities()) as Partial<
        Record<keyof NativeNfcCapabilities, unknown>
      >;
      return {
        available: true,
        supported: caps.supported === true,
        enabled: caps.enabled === true,
        canEmit: caps.canEmit === true,
        canRead: caps.canRead === true,
      };
    },
    setEmittedPayload: (uri) => {
      assertEmittable(uri);
      native.setEmittedPayload(uri);
    },
    startReading: () => native.startReading(),
    stopReading: () => {
      native.stopReading();
    },
    openNfcSettings: () => {
      native.openNfcSettings();
    },
    addListener,
  };
}

export const UNAVAILABLE_NFC_CAPABILITIES: NfcCapabilities = {
  available: false,
  supported: false,
  enabled: false,
  canEmit: false,
  canRead: false,
};

/**
 * Sem o módulo nativo (Expo Go, web, dev build antigo): o NFC aparece como indisponível e a tela
 * Conectar fica só com o QR code. Nada é emitido nem lido.
 */
export function createUnavailableNfc(): Nfc {
  return {
    getNfcCapabilities: () => Promise.resolve(UNAVAILABLE_NFC_CAPABILITIES),
    setEmittedPayload: (uri) => {
      assertEmittable(uri);
    },
    startReading: () => Promise.reject(new Error('NFC indisponível neste build.')),
    stopReading: () => undefined,
    openNfcSettings: () => undefined,
    addListener: () => NOOP_SUBSCRIPTION,
  };
}

let shared: Nfc | null = null;

/** O NFC do app: o nativo quando existe neste build; senão, o indisponível. */
export function getNfc(): Nfc {
  if (shared === null) {
    const native = requireOptionalNativeModule<SussurroProximityNativeModule>(NATIVE_MODULE_NAME);
    shared = native === null ? createUnavailableNfc() : createNativeNfc(native);
  }
  return shared;
}

/** Só para os testes: esquece a instância de `getNfc`. */
export function resetNfcForTests(): void {
  shared = null;
}
