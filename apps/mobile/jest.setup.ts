import { actionSheetTiming } from '@sussurro/ui';

import { timing } from './src/lib/timing';

// Safe area previsível nos testes (insets zerados).
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

// Módulos nativos usados pelo app: dublês em memória (os testes de tela injetam a sessão).
jest.mock('expo-secure-store', () => {
  const values = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: jest.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
  };
});

// Câmera (leitura do QR, Fase 4): permissão e leituras controladas pelo teste.
jest.mock(
  'expo-camera',
  () => (require('./src/test-utils/camera-mock') as { expoCameraMock: unknown }).expoCameraMock,
);

// Reels (Fase 5): o player do expo-video controlado pelo teste e a capa sem o módulo nativo (as telas
// usam o dublê de `test-utils/fake-media.ts`; este mock só evita carregar o nativo).
jest.mock(
  'expo-video',
  () => (require('./src/test-utils/video-mock') as { expoVideoMock: unknown }).expoVideoMock,
);
jest.mock('expo-video-thumbnails', () => ({
  getThumbnailAsync: jest.fn(() => Promise.reject(new Error('use o dublê de mídia nos testes'))),
}));

// Notificações (Fase 6): as telas usam o dublê de `test-utils/fake-push.ts` (PushProvider); este
// mock só evita carregar o módulo nativo. `native-push.test.ts` troca o retorno quando precisa.
jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  AndroidImportance: { DEFAULT: 3 },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve(null)),
  getPermissionsAsync: jest.fn(() =>
    Promise.resolve({
      status: 'undetermined',
      granted: false,
      canAskAgain: true,
      expires: 'never',
    }),
  ),
  requestPermissionsAsync: jest.fn(() =>
    Promise.resolve({ status: 'granted', granted: true, canAskAgain: true, expires: 'never' }),
  ),
  getExpoPushTokenAsync: jest.fn(() =>
    Promise.resolve({ type: 'expo', data: 'ExponentPushToken[nativo]' }),
  ),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
}));

// Sentry (Fase 6): o SDK é ESM e nativo; nos testes nada é enviado. `sentry.test.ts` confere as opções.
jest.mock('@sentry/react-native', () => ({ init: jest.fn(), captureException: jest.fn() }));

// Rede "online" por padrão; os testes de offline trocam o retorno.
jest.mock('expo-network', () => ({
  useNetworkState: jest.fn(() => ({ isConnected: true, isInternetReachable: true })),
}));

// Consultas de mídia em `processing` sem espera real nos testes.
timing.pollIntervalMs = 1;

// Busca sem a pausa da digitação, e o menu ⋯ executa a ação sem esperar o onDismiss do Modal
// (o Modal dos testes não o chama).
timing.searchDebounceMs = 0;
timing.pushPromptDelayMs = 0;
actionSheetTiming.iosDismissFallbackMs = 0;

// A janela das emissões de tokens do Conectar fica no módulo e é da sessão (PROX-68): cada teste
// começa com ela vazia, sem depender da desmontagem do `RootNavigator` no fim do teste anterior (nem
// valer só para quem chama `forgetTokenIssues`). O `require` fica no `beforeEach`, depois dos
// `jest.mock` e dos imports do arquivo de teste: é a mesma instância do módulo que o teste usa.
beforeEach(() => {
  (
    require('./src/features/connect/hooks') as { forgetTokenIssues: () => void }
  ).forgetTokenIssues();
});
