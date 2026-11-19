// Módulo Expo local `sussurro-proximity` (ADR 0013 §4): o código de conexão `sussurro://c/{token}`
// por NFC. Android: emite como tag Type 4 (HCE) e lê em reader mode; iPhone: só lê, pela folha do
// sistema. O nativo (Swift em `ios/`, Kotlin em `android/`) só existe no dev build; sem ele,
// `getNfc()` devolve o NFC indisponível. O NFC falso dos testes fica em `src/fake-nfc` (fora deste
// índice, para não entrar no bundle).
export * from './src/SussurroProximity.types';
export {
  createNativeNfc,
  createUnavailableNfc,
  getNfc,
  NATIVE_MODULE_NAME,
  UNAVAILABLE_NFC_CAPABILITIES,
} from './src/nfc';
