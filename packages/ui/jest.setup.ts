import { actionSheetTiming } from './src/components/ActionSheet/ActionSheet';

// Safe area previsível nos testes (insets zerados).
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

// O Modal dos testes não chama `onDismiss`: a ação escolhida no menu roda sem esperar.
actionSheetTiming.iosDismissFallbackMs = 0;

// Player do expo-video controlado pelo teste (o mock do pacote não termina o vídeo).
jest.mock(
  'expo-video',
  () => (require('./src/test-utils/video-mock') as { expoVideoMock: unknown }).expoVideoMock,
);
