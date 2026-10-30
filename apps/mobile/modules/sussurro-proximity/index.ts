// Módulo Expo local `sussurro-proximity` (ADR 0002): anúncio + varredura BLE sem GATT, com o token
// de proximidade num UUID de serviço de 128 bits. O nativo (Swift em `ios/`, Kotlin em `android/`)
// só existe no dev build; sem ele, `getProximityRadio()` devolve o rádio indisponível. O rádio falso
// dos testes fica em `src/fake-radio` (fora deste índice, para não entrar no bundle).
export * from './src/SussurroProximity.types';
export {
  createNativeRadio,
  createUnavailableRadio,
  getProximityRadio,
  NATIVE_MODULE_NAME,
  UNAVAILABLE_CAPABILITIES,
} from './src/radio';
