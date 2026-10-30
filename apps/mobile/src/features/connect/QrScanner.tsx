import { EmptyState, IconButton, Text, theme, useReducedMotion } from '@sussurro/ui';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ActivityIndicator, Linking, Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COPY } from './copy';

export interface QrScannerProps {
  error: string | null;
  busy: boolean;
  onRead: (data: string) => void;
  onClose: () => void;
  /** "Mostrar meu código" com a câmera negada. */
  onShowMyCode: () => void;
}

/**
 * Leitura do QR com a câmera (4.7, `expo-camera`), em tela cheia por cima da tela Conectar (que
 * continua aberta no servidor). Só lê QR codes; nada é fotografado nem gravado. Antes do pedido do
 * sistema, a explicação do ux.md §4.12; negada, "Câmera sem permissão" (4.7 CA5).
 */
export function QrScanner({ error, busy, onRead, onClose, onShowMyCode }: QrScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  const ask = () => {
    requestPermission().catch(() => undefined);
  };
  const openSettings = () => {
    Linking.openSettings().catch(() => undefined);
  };

  const granted = permission?.granted === true;
  let body;
  if (permission === null) {
    body = <ActivityIndicator style={styles.center} color={theme.colors.grey} />;
  } else if (granted) {
    body = (
      <>
        <CameraView
          testID="qr-camera"
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          {...(busy
            ? {}
            : {
                onBarcodeScanned: ({ data }: { data: string }) => {
                  onRead(data);
                },
              })}
        />
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.frame} />
          <Text variant="bodyStrong" color="white" align="center" style={styles.hint}>
            {COPY.scannerHint}
          </Text>
          {busy ? <ActivityIndicator color={theme.colors.white} /> : null}
          {error === null ? null : (
            <View style={styles.errorChip} accessibilityLiveRegion="polite">
              <Text variant="bodySm" color="white" align="center" testID="qr-erro">
                {error}
              </Text>
            </View>
          )}
        </View>
      </>
    );
  } else if (permission.canAskAgain) {
    body = (
      <EmptyState
        icon="camera"
        title={COPY.cameraExplainTitle}
        description={COPY.cameraExplainText}
        primaryAction={{ label: COPY.continue, onPress: ask }}
        testID="camera-explicacao"
      />
    );
  } else {
    body = (
      <EmptyState
        icon="camera"
        title={COPY.cameraDeniedTitle}
        description={COPY.cameraDeniedText}
        primaryAction={{ label: COPY.openSettings, onPress: openSettings }}
        secondaryAction={{ label: COPY.showMyCode, onPress: onShowMyCode }}
        testID="camera-negada"
      />
    );
  }

  return (
    <Modal
      visible
      animationType={reduceMotion ? 'none' : 'slide'}
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View
        style={[styles.screen, granted ? styles.dark : styles.light]}
        accessibilityViewIsModal
        testID="qr-scanner"
      >
        {body}
        <View style={[styles.header, { paddingTop: insets.top }]}>
          <IconButton
            icon="x"
            accessibilityLabel={COPY.close}
            color={granted ? 'white' : 'black'}
            onPress={onClose}
          />
          <Text
            variant="titleSm"
            color={granted ? 'white' : 'black'}
            accessibilityRole="header"
            style={styles.title}
          >
            {COPY.scannerTitle}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const FRAME = 240;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  dark: { backgroundColor: theme.colors.black },
  light: { backgroundColor: theme.colors.white, paddingTop: theme.layout.headerHeight },
  center: { flex: 1 },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.space[4],
    minHeight: theme.layout.headerHeight,
  },
  title: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[16],
    paddingHorizontal: theme.layout.screenX,
  },
  frame: {
    width: FRAME,
    height: FRAME,
    borderRadius: theme.radius.xl,
    borderWidth: 3,
    borderColor: theme.colors.white,
  },
  hint: { maxWidth: 300 },
  errorChip: {
    maxWidth: 320,
    paddingHorizontal: theme.space[12],
    paddingVertical: theme.space[8],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.mediaChip,
  },
});
