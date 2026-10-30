import type {
  BluetoothPermission,
  BluetoothState,
  NativeSubscription,
  ProximityCapabilities,
  ProximityRadio,
  ProximityRadioError,
  ProximitySighting,
} from './SussurroProximity.types';

export const READY_CAPABILITIES: ProximityCapabilities = {
  available: true,
  bleSupported: true,
  bluetooth: 'on',
  permission: 'granted',
  canAskAgain: true,
  canAdvertise: true,
};

export interface FakeRadio extends ProximityRadio {
  /** O que `getCapabilities` devolve agora (mutável nos testes). */
  capabilities: ProximityCapabilities;
  /** Resposta da pessoa ao pedido do sistema em `requestPermission`. */
  permissionAnswer: BluetoothPermission;
  /** Token anunciado agora (`null` = sem anúncio). */
  advertising: string | null;
  /** Todos os tokens anunciados, em ordem. */
  advertised: string[];
  scanning: boolean;
  keepScreenOn: boolean;
  permissionRequests: number;
  enableRequests: number;
  /** Simula um anúncio visto na varredura (só chega se estiver varrendo). */
  emitSighting: (token: string, rssi: number) => void;
  emitState: (state: BluetoothState) => void;
  emitError: (error: ProximityRadioError) => void;
}

/**
 * Rádio em memória para os testes (e para quem quiser simular sem aparelho): guarda o que foi
 * anunciado e deixa o teste "ver" outros aparelhos.
 */
export function createFakeRadio(capabilities: Partial<ProximityCapabilities> = {}): FakeRadio {
  const sightingListeners = new Set<(sighting: ProximitySighting) => void>();
  const stateListeners = new Set<(state: BluetoothState) => void>();
  const errorListeners = new Set<(error: ProximityRadioError) => void>();

  function subscribe<T>(set: Set<T>, listener: T): NativeSubscription {
    set.add(listener);
    return {
      remove: () => {
        set.delete(listener);
      },
    };
  }

  const radio: FakeRadio = {
    capabilities: { ...READY_CAPABILITIES, ...capabilities },
    permissionAnswer: 'granted',
    advertising: null,
    advertised: [],
    scanning: false,
    keepScreenOn: false,
    permissionRequests: 0,
    enableRequests: 0,
    getCapabilities: () => Promise.resolve({ ...radio.capabilities }),
    requestPermission: () => {
      radio.permissionRequests += 1;
      if (radio.capabilities.permission === 'undetermined') {
        radio.capabilities = {
          ...radio.capabilities,
          permission: radio.permissionAnswer,
          canAskAgain: radio.permissionAnswer !== 'denied',
        };
      }
      return Promise.resolve({ ...radio.capabilities });
    },
    requestEnableBluetooth: () => {
      radio.enableRequests += 1;
      return Promise.resolve(true);
    },
    startAdvertising: (token) => {
      radio.advertising = token;
      radio.advertised.push(token);
      return Promise.resolve();
    },
    stopAdvertising: () => {
      radio.advertising = null;
      return Promise.resolve();
    },
    startScan: () => {
      radio.scanning = true;
      return Promise.resolve();
    },
    stopScan: () => {
      radio.scanning = false;
      return Promise.resolve();
    },
    setKeepScreenOn: (enabled) => {
      radio.keepScreenOn = enabled;
      return Promise.resolve();
    },
    onSighting: (listener) => subscribe(sightingListeners, listener),
    onStateChange: (listener) => subscribe(stateListeners, listener),
    onError: (listener) => subscribe(errorListeners, listener),
    emitSighting: (token, rssi) => {
      if (!radio.scanning) return;
      for (const listener of [...sightingListeners]) listener({ token, rssi });
    },
    emitState: (state) => {
      radio.capabilities = { ...radio.capabilities, bluetooth: state };
      for (const listener of [...stateListeners]) listener(state);
    },
    emitError: (error) => {
      for (const listener of [...errorListeners]) listener(error);
    },
  };
  return radio;
}
