import {
  BLE_SERVICE_UUID_PREFIX,
  proximityTokenToServiceUuid,
  serviceUuidToProximityToken,
} from '@sussurro/shared';
import { requireOptionalNativeModule } from 'expo';

import type {
  NativeCapabilities,
  NativeSubscription,
  ProximityCapabilities,
  ProximityRadio,
  SussurroProximityNativeModule,
} from './SussurroProximity.types';

/** Nome do módulo nos dois nativos (`Name("SussurroProximity")`). */
export const NATIVE_MODULE_NAME = 'SussurroProximity';

/** RSSI fora da faixa de um anúncio real (o iOS manda 127 quando não mediu). */
function isUsableRssi(rssi: number): boolean {
  return Number.isFinite(rssi) && rssi < 0 && rssi > -128;
}

function withAvailability(capabilities: NativeCapabilities): ProximityCapabilities {
  return { ...capabilities, available: true };
}

/**
 * O rádio sobre o módulo nativo. A lógica de bytes fica aqui, testável (4.3 CA6, A-20): o token vira
 * o UUID de serviço anunciado (`53555353-…`, sem nome nem outro dado), e cada UUID visto volta a
 * ser token. UUID sem o prefixo, curto ou mal formado é ignorado.
 */
export function createNativeRadio(native: SussurroProximityNativeModule): ProximityRadio {
  return {
    getCapabilities: async () => withAvailability(await native.getCapabilitiesAsync()),
    requestPermission: async () => withAvailability(await native.requestPermissionAsync()),
    requestEnableBluetooth: () => native.requestEnableBluetoothAsync(),
    startAdvertising: (token) => native.startAdvertisingAsync(proximityTokenToServiceUuid(token)),
    stopAdvertising: () => native.stopAdvertisingAsync(),
    startScan: () => native.startScanAsync(BLE_SERVICE_UUID_PREFIX),
    stopScan: () => native.stopScanAsync(),
    setKeepScreenOn: (enabled) => native.setKeepScreenOnAsync(enabled),
    onSighting: (listener) =>
      native.addListener('onSighting', ({ uuid, rssi }) => {
        const token = serviceUuidToProximityToken(uuid);
        if (token !== null && isUsableRssi(rssi)) {
          listener({ token, rssi });
        }
      }),
    onStateChange: (listener) =>
      native.addListener('onStateChange', ({ bluetooth }) => {
        listener(bluetooth);
      }),
    onError: (listener) => native.addListener('onError', listener),
  };
}

const NOOP_SUBSCRIPTION: NativeSubscription = { remove: () => undefined };

export const UNAVAILABLE_CAPABILITIES: ProximityCapabilities = {
  available: false,
  bleSupported: false,
  bluetooth: 'unsupported',
  permission: 'undetermined',
  canAskAgain: false,
  canAdvertise: false,
};

/**
 * Sem o módulo nativo (Expo Go, web, dev build antigo): o Bluetooth aparece como indisponível e a
 * tela Conectar oferece o QR code. Nada é anunciado nem varrido.
 */
export function createUnavailableRadio(): ProximityRadio {
  const unsupported = () => Promise.reject(new Error('Bluetooth indisponível neste build.'));
  return {
    getCapabilities: () => Promise.resolve(UNAVAILABLE_CAPABILITIES),
    requestPermission: () => Promise.resolve(UNAVAILABLE_CAPABILITIES),
    requestEnableBluetooth: () => Promise.resolve(false),
    startAdvertising: unsupported,
    stopAdvertising: () => Promise.resolve(),
    startScan: unsupported,
    stopScan: () => Promise.resolve(),
    setKeepScreenOn: () => Promise.resolve(),
    onSighting: () => NOOP_SUBSCRIPTION,
    onStateChange: () => NOOP_SUBSCRIPTION,
    onError: () => NOOP_SUBSCRIPTION,
  };
}

let shared: ProximityRadio | null = null;

/** O rádio do app: o nativo quando existe neste build; senão, o indisponível. */
export function getProximityRadio(): ProximityRadio {
  if (shared === null) {
    const native = requireOptionalNativeModule<SussurroProximityNativeModule>(NATIVE_MODULE_NAME);
    shared = native === null ? createUnavailableRadio() : createNativeRadio(native);
  }
  return shared;
}
