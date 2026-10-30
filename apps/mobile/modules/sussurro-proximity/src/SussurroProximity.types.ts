/**
 * Tipos do módulo `sussurro-proximity` (ADR 0002): anúncio e varredura BLE sem conexão GATT. O
 * nativo só conhece UUIDs; a conversão token ↔ UUID fica em TypeScript (`@sussurro/shared`).
 */

/** Estado do rádio Bluetooth do aparelho. */
export type BluetoothState = 'on' | 'off' | 'unauthorized' | 'unsupported' | 'unknown';

/**
 * Permissão de Bluetooth: no iOS, "Bluetooth"; no Android 12+, "Dispositivos próximos"
 * (`BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`); no Android ≤ 11, a localização
 * que o sistema exige para varrer.
 */
export type BluetoothPermission = 'granted' | 'denied' | 'undetermined';

/** O que o nativo devolve em `getCapabilitiesAsync` e `requestPermissionAsync`. */
export interface NativeCapabilities {
  /** O aparelho tem Bluetooth Low Energy. */
  bleSupported: boolean;
  bluetooth: BluetoothState;
  permission: BluetoothPermission;
  /** `false`: o sistema não mostra mais o pedido (só pelos Ajustes). */
  canAskAgain: boolean;
  /**
   * Consegue anunciar (Android: `isMultipleAdvertisementSupported`). Só é confiável com o
   * Bluetooth ligado; desligado, vale `true` até poder conferir.
   */
  canAdvertise: boolean;
}

/** Capacidades vistas pelo app: as do nativo e se o módulo existe neste build. */
export interface ProximityCapabilities extends NativeCapabilities {
  /** `false` no Expo Go, na web e em dev build sem o módulo (gerado antes da Fase 4b). */
  available: boolean;
}

/** Evento `onSighting`: um UUID com o prefixo do Sussurro visto na varredura. */
export interface NativeSightingEvent {
  uuid: string;
  /** dBm (negativo). 127 = indisponível: ignorado. */
  rssi: number;
}

export interface NativeStateEvent {
  bluetooth: BluetoothState;
}

export interface NativeErrorEvent {
  operation: 'advertise' | 'scan';
  /** Ex.: `unsupported`, `too_many_advertisers`, `scan_failed`. Só para diagnóstico. */
  code: string;
}

export interface NativeSubscription {
  remove: () => void;
}

export interface NativeEvents {
  onSighting: (event: NativeSightingEvent) => void;
  onStateChange: (event: NativeStateEvent) => void;
  onError: (event: NativeErrorEvent) => void;
}

/** Superfície do módulo nativo (Swift e Kotlin implementam exatamente isto). */
export interface SussurroProximityNativeModule {
  getCapabilitiesAsync: () => Promise<NativeCapabilities>;
  /** Mostra o pedido do sistema se ainda der; devolve as capacidades depois da resposta. */
  requestPermissionAsync: () => Promise<NativeCapabilities>;
  /** Anuncia só este UUID de serviço de 128 bits (sem nome). Substitui o anúncio anterior. */
  startAdvertisingAsync: (serviceUuid: string) => Promise<void>;
  stopAdvertisingAsync: () => Promise<void>;
  /** Varre e emite `onSighting` para os UUIDs que começam com o prefixo (8 dígitos hex). */
  startScanAsync: (prefixHex: string) => Promise<void>;
  stopScanAsync: () => Promise<void>;
  /** Android: o pedido do sistema para ligar o Bluetooth. iOS: `false` (só pelos Ajustes). */
  requestEnableBluetoothAsync: () => Promise<boolean>;
  /** Mantém a tela acesa enquanto procura ou aguarda (ux.md §5.2). */
  setKeepScreenOnAsync: (enabled: boolean) => Promise<void>;
  addListener: <E extends keyof NativeEvents>(
    event: E,
    listener: NativeEvents[E],
  ) => NativeSubscription;
}

/** Um token de proximidade visto por perto, com a força do sinal (nunca vai para o servidor). */
export interface ProximitySighting {
  token: string;
  rssi: number;
}

export type ProximityRadioError = NativeErrorEvent;

/**
 * O que o app usa (tela Conectar). Tokens entram e saem; UUIDs ficam escondidos aqui. Tem uma
 * implementação nativa, uma "indisponível" (sem o módulo) e uma falsa para os testes.
 */
export interface ProximityRadio {
  getCapabilities: () => Promise<ProximityCapabilities>;
  requestPermission: () => Promise<ProximityCapabilities>;
  requestEnableBluetooth: () => Promise<boolean>;
  startAdvertising: (token: string) => Promise<void>;
  stopAdvertising: () => Promise<void>;
  startScan: () => Promise<void>;
  stopScan: () => Promise<void>;
  setKeepScreenOn: (enabled: boolean) => Promise<void>;
  onSighting: (listener: (sighting: ProximitySighting) => void) => NativeSubscription;
  onStateChange: (listener: (state: BluetoothState) => void) => NativeSubscription;
  onError: (listener: (error: ProximityRadioError) => void) => NativeSubscription;
}
