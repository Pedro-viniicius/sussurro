/**
 * Tipos do módulo `sussurro-proximity` (ADR 0002; ADR 0012, "Conectar encostando", e adendo A1):
 * anúncio e varredura BLE sem conexão GATT. O nativo só conhece UUIDs e recebe a potência e o
 * intervalo por parâmetro; a conversão token ↔ UUID fica em TypeScript (`@sussurro/shared`) e os
 * limiares do encosto ficam no app (`touch-calibration.ts`). Swift e Kotlin não guardam nenhum
 * limiar, não põem o campo TX Power no anúncio e não o leem na varredura (A1).
 */

/** Estado do rádio Bluetooth do aparelho. */
export type BluetoothState = 'on' | 'off' | 'unauthorized' | 'unsupported' | 'unknown';

/**
 * Permissão de Bluetooth: no iOS, "Bluetooth"; no Android 12+, "Dispositivos próximos"
 * (`BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`); no Android ≤ 11, a localização
 * que o sistema exige para varrer.
 */
export type BluetoothPermission = 'granted' | 'denied' | 'undetermined';

/**
 * Localização do sistema (ADR 0012 §2): o Android ≤ 11 só entrega a varredura com ela ligada
 * (desligada, a varredura volta vazia, sem erro). `not_required` no Android 12+ e no iOS.
 */
export type LocationServices = 'on' | 'off' | 'not_required';

/**
 * Potência do anúncio no Android (`AdvertiseSettings.ADVERTISE_TX_POWER_*`; no AOSP, -21, -15, -7 e
 * +1 dBm). O iOS não deixa escolher: anuncia na potência do sistema e ignora o parâmetro.
 */
export type AdvertiseTxPower = 'ultraLow' | 'low' | 'medium' | 'high';

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
  locationServices: LocationServices;
  /**
   * Modelo do aparelho (Android: `Build.MODEL`; iOS: o identificador, ex.: `iPhone15,2`). Usado só
   * no aparelho, na correção de calibração por modelo; **nunca vai para a API** (PROX-43).
   */
  deviceModel: string;
}

/** Capacidades vistas pelo app: as do nativo e se o módulo existe neste build. */
export interface ProximityCapabilities extends NativeCapabilities {
  /** `false` no Expo Go, na web e em dev build sem o módulo (gerado antes da Fase 4b). */
  available: boolean;
}

/**
 * Evento `onSighting`: um UUID com o prefixo do Sussurro visto na varredura, com o RSSI medido por
 * este aparelho. O campo TX Power do anúncio não é lido (ADR 0012, adendo A1); se um nativo antigo
 * ainda mandar `txPower`, o rádio descarta o campo e mantém o anúncio.
 */
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
  /**
   * Anuncia só este UUID de serviço de 128 bits (sem nome e sem o campo TX Power, ADR 0012 adendo
   * A1). Substitui o anúncio anterior. No Android, `txPower` é a potência (nível desconhecido
   * rejeita a promise); o iOS a ignora.
   */
  startAdvertisingAsync: (serviceUuid: string, txPower: AdvertiseTxPower) => Promise<void>;
  stopAdvertisingAsync: () => Promise<void>;
  /**
   * Varre e emite `onSighting` para os UUIDs que começam com o prefixo (8 dígitos hex), no máximo
   * um evento por UUID a cada `minIntervalMs`. Chamado de novo com a varredura já ligada e o mesmo
   * prefixo, só troca o intervalo: não reinicia a varredura (o Android segura em silêncio mais de
   * cerca de 5 inícios em 30 s).
   */
  startScanAsync: (prefixHex: string, minIntervalMs: number) => Promise<void>;
  stopScanAsync: () => Promise<void>;
  /** Android: o pedido do sistema para ligar o Bluetooth. iOS: `false` (só pelos Ajustes). */
  requestEnableBluetoothAsync: () => Promise<boolean>;
  /** Mantém a tela acesa (ux.md §11.4, regras gerais). */
  setKeepScreenOnAsync: (enabled: boolean) => Promise<void>;
  addListener: <E extends keyof NativeEvents>(
    event: E,
    listener: NativeEvents[E],
  ) => NativeSubscription;
}

/**
 * Um token de proximidade visto na varredura, com a força do sinal medida por este aparelho. Nada
 * do que o emissor declara entra aqui (ADR 0012, adendo A1). Nada disso vai para o servidor: o app
 * só afirma "encostado" (ADR 0012 §2, PROX-43).
 */
export interface ProximitySighting {
  token: string;
  rssi: number;
}

export type ProximityRadioError = NativeErrorEvent;

/** Parâmetros do anúncio vindos da calibração (`touch-calibration.ts`). */
export interface AdvertiseOptions {
  /** Potência no Android; o iOS a ignora. */
  txPower: AdvertiseTxPower;
}

/** Parâmetros da varredura vindos da calibração. */
export interface ScanOptions {
  minIntervalMs: number;
}

/**
 * O que o app usa (tela Conectar e a calibração em dev). Tokens entram e saem; UUIDs ficam
 * escondidos aqui. Tem uma implementação nativa, uma "indisponível" (sem o módulo) e uma falsa
 * para os testes.
 */
export interface ProximityRadio {
  getCapabilities: () => Promise<ProximityCapabilities>;
  requestPermission: () => Promise<ProximityCapabilities>;
  requestEnableBluetooth: () => Promise<boolean>;
  startAdvertising: (token: string, options: AdvertiseOptions) => Promise<void>;
  stopAdvertising: () => Promise<void>;
  startScan: (options: ScanOptions) => Promise<void>;
  stopScan: () => Promise<void>;
  setKeepScreenOn: (enabled: boolean) => Promise<void>;
  onSighting: (listener: (sighting: ProximitySighting) => void) => NativeSubscription;
  onStateChange: (listener: (state: BluetoothState) => void) => NativeSubscription;
  onError: (listener: (error: ProximityRadioError) => void) => NativeSubscription;
}
