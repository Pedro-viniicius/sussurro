/**
 * Tipos do módulo `sussurro-proximity` (ADR 0013 §4): o código de conexão `sussurro://c/{token}`
 * por NFC. No Android, o aparelho emite o código como uma tag NFC Forum Type 4 (HCE) e lê o de
 * outro aparelho em reader mode; no iPhone, só lê, pela folha do sistema (`NFCNDEFReaderSession`).
 * Não há Bluetooth.
 */

/** O que o nativo devolve em `getNfcCapabilities`. */
export interface NativeNfcCapabilities {
  /** O aparelho tem NFC (Android: `NfcAdapter` existe; iOS: `readingAvailable`). */
  supported: boolean;
  /** O NFC está ligado (Android: `isEnabled`; iOS: igual a `supported`, não dá para desligar). */
  enabled: boolean;
  /** Consegue emitir o código como tag (Android com HCE; iPhone: sempre `false`). */
  canEmit: boolean;
  /** Consegue ler o código de outro aparelho (igual a `supported`). */
  canRead: boolean;
}

/** Capacidades vistas pelo app: as do nativo e se o módulo existe neste build. */
export interface NfcCapabilities extends NativeNfcCapabilities {
  /** `false` no Expo Go, na web e em dev build sem o módulo NFC. */
  available: boolean;
}

/**
 * Por que a leitura parou sem um código:
 * - `cancelled`: a pessoa fechou a folha do sistema (iPhone);
 * - `timeout`: a folha do sistema expirou (iPhone, cerca de 60 s);
 * - `unsupported`: o aparelho não lê NFC;
 * - `disabled`: o NFC está desligado (Android) ou o sistema recusou abrir a leitura;
 * - `read_failed`: a tag saiu do campo no meio, ou não tinha um código do Sussurro legível.
 */
export type NfcReadErrorCode = 'cancelled' | 'timeout' | 'unsupported' | 'disabled' | 'read_failed';

/** `onNfcRead`: um código do Sussurro lido (já filtrado pelo prefixo `sussurro://c/`). */
export interface NfcReadEvent {
  uri: string;
}

/** `onNfcReadError`: a leitura falhou ou foi encerrada sem código. */
export interface NfcReadErrorEvent {
  code: NfcReadErrorCode;
}

/** `onNfcStateChange` (só Android): o NFC foi ligado ou desligado nos Ajustes. */
export interface NfcStateEvent {
  enabled: boolean;
}

export interface NfcSubscription {
  remove: () => void;
}

export interface NfcEvents {
  onNfcRead: (event: NfcReadEvent) => void;
  onNfcReadError: (event: NfcReadErrorEvent) => void;
  onNfcStateChange: (event: NfcStateEvent) => void;
}

export type NfcEventName = keyof NfcEvents;

/** Superfície do módulo nativo (Swift e Kotlin implementam exatamente isto). */
export interface SussurroProximityNativeModule {
  getNfcCapabilities: () => Promise<NativeNfcCapabilities>;
  /** Android: grava (ou apaga, com `null`) o código que o HCE entrega. iOS: nada. */
  setEmittedPayload: (uri: string | null) => void;
  /** Android: liga o reader mode na Activity atual. iOS: abre a folha do sistema. */
  startReading: () => Promise<void>;
  stopReading: () => void;
  /** Android: abre os Ajustes do NFC. iOS: nada. */
  openNfcSettings: () => void;
  addListener: <E extends NfcEventName>(event: E, listener: NfcEvents[E]) => NfcSubscription;
}

/**
 * O que o app usa (tela Conectar). Tem uma implementação nativa, uma "indisponível" (sem o
 * módulo) e uma falsa para os testes (`src/fake-nfc`).
 */
export interface Nfc {
  getNfcCapabilities: () => Promise<NfcCapabilities>;
  /**
   * Código a emitir por NFC (`sussurro://c/{token}`), ou `null` para parar de emitir. Android com
   * HCE; no iPhone e sem o módulo, não faz nada. Conteúdo fora do formato é bug do app e lança erro.
   */
  setEmittedPayload: (uri: string | null) => void;
  /**
   * Android: reader mode contínuo até `stopReading` (enquanto liga, o aparelho não é lido por
   * outro). iPhone: abre a folha do sistema, que fecha sozinha depois do 1º código. Sem o módulo,
   * rejeita.
   */
  startReading: () => Promise<void>;
  stopReading: () => void;
  /** Android: abre os Ajustes do NFC ("Ligar NFC"). iPhone e sem o módulo: nada. */
  openNfcSettings: () => void;
  addListener: <E extends NfcEventName>(event: E, listener: NfcEvents[E]) => NfcSubscription;
}
