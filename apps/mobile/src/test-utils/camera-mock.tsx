import { useState } from 'react';
import { View, type ViewProps } from 'react-native';

/**
 * Dublê do `expo-camera` nos testes: a permissão é controlada pelo teste e o `CameraView` é uma
 * View com o `onBarcodeScanned` (o teste "lê" um QR com `fireEvent(camera, 'barcodeScanned', …)`).
 */
interface Permission {
  status: 'granted' | 'denied' | 'undetermined';
  granted: boolean;
  canAskAgain: boolean;
  expires: 'never';
}

function permission(status: Permission['status'], canAskAgain = true): Permission {
  return { status, granted: status === 'granted', canAskAgain, expires: 'never' };
}

export const cameraMock = {
  /** Estado inicial da permissão em cada montagem. */
  initial: permission('granted'),
  /** Resposta da pessoa ao pedido do sistema. */
  answer: permission('granted'),
  requests: 0,
  set(status: Permission['status'], canAskAgain = true) {
    cameraMock.initial = permission(status, canAskAgain);
  },
  respond(status: Permission['status'], canAskAgain = true) {
    cameraMock.answer = permission(status, canAskAgain);
  },
  reset() {
    cameraMock.initial = permission('granted');
    cameraMock.answer = permission('granted');
    cameraMock.requests = 0;
  },
};

function CameraView(props: ViewProps & { onBarcodeScanned?: (event: { data: string }) => void }) {
  return <View {...props} />;
}

function useCameraPermissions() {
  const [current, setCurrent] = useState<Permission>(cameraMock.initial);
  const request = () => {
    cameraMock.requests += 1;
    const next = cameraMock.answer;
    setCurrent(next);
    return Promise.resolve(next);
  };
  return [current, request, () => Promise.resolve(current)] as const;
}

export const expoCameraMock = { CameraView, useCameraPermissions };
