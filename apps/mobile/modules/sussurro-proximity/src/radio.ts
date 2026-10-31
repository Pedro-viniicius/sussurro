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

/** Capacidades de um nativo antigo (sem os campos da ADR 0012) ficam com padrões seguros. */
function withAvailability(capabilities: NativeCapabilities): ProximityCapabilities {
  const partial = capabilities as Partial<NativeCapabilities>;
  return {
    ...capabilities,
    locationServices: partial.locationServices ?? 'not_required',
    deviceModel: typeof partial.deviceModel === 'string' ? partial.deviceModel : '',
    available: true,
  };
}

/**
 * O rádio sobre o módulo nativo. A lógica de bytes fica aqui, testável (4.3 CA6, A-20): o token vira
 * o UUID de serviço anunciado (`53555353-…`, sem nome nem outro dado), e cada UUID visto volta a
 * ser token, só com o RSSI medido aqui. UUID sem o prefixo, curto ou mal formado é ignorado.
 *
 * ADR 0012, adendo A1: o avistamento é montado só com o token e o RSSI. Qualquer outro campo do
 * evento nativo é ignorado, inclusive o `txPower` que um dev build antigo ainda mande; o anúncio
 * não é descartado por trazê-lo (o atacante só omitiria o campo, como já faz um iPhone).
 */
export function createNativeRadio(native: SussurroProximityNativeModule): ProximityRadio {
  return {
    getCapabilities: async () => withAvailability(await native.getCapabilitiesAsync()),
    requestPermission: async () => withAvailability(await native.requestPermissionAsync()),
    requestEnableBluetooth: () => native.requestEnableBluetoothAsync(),
    startAdvertising: (token, { txPower }) =>
      native.startAdvertisingAsync(proximityTokenToServiceUuid(token), txPower),
    stopAdvertising: () => native.stopAdvertisingAsync(),
    startScan: ({ minIntervalMs }) =>
      native.startScanAsync(BLE_SERVICE_UUID_PREFIX, Math.max(0, Math.round(minIntervalMs))),
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
  locationServices: 'not_required',
  deviceModel: '',
};

/**
 * Sem o módulo nativo (Expo Go, web, dev build antigo): o Bluetooth aparece como indisponível e a
 * tela Conectar abre no QR code. Nada é anunciado nem varrido.
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
