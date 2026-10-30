import type { ConnectionRequest } from '@sussurro/shared';
import { Avatar, Button, IconButton, Text, theme, useReducedMotion } from '@sussurro/ui';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COPY, firstName, formatCountdown } from './copy';

export interface IncomingRequestSheetProps {
  request: ConnectionRequest;
  secondsLeft: number;
  /** Mensagem do aceite que não deu certo (o pedido continua valendo). */
  error: string | null;
  busy: boolean;
  /** No QR (D7) o aceite é ler o código de quem pediu. */
  acceptByQr: boolean;
  onAccept: () => void;
  onDecline: () => void;
  /** Fecha sem responder (✕ ou voltar do Android): o pedido segue valendo até vencer. */
  onClose: () => void;
}

/**
 * Folha "Helena quer se conectar" (ux.md §4.11, 4.6 CA1): avatar, nome, @, Aceitar, Recusar e o
 * tempo restante, que não é anunciado a cada segundo. Uma folha por vez (a fila fica na tela).
 */
export function IncomingRequestSheet({
  request,
  secondsLeft,
  error,
  busy,
  acceptByQr,
  onAccept,
  onDecline,
  onClose,
}: IncomingRequestSheetProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const { other } = request;
  const first = firstName(other.name);

  return (
    <Modal
      visible
      transparent
      animationType={reduceMotion ? 'none' : 'slide'}
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessible={false}
          importantForAccessibility="no"
          onPress={onClose}
        />
        <View
          style={[styles.sheet, { paddingBottom: insets.bottom + theme.space[16] }]}
          accessibilityViewIsModal
          testID="folha-pedido"
        >
          <View style={styles.topRow}>
            <View style={styles.grabber} />
            <View style={styles.close}>
              <IconButton icon="x" accessibilityLabel={COPY.close} onPress={onClose} />
            </View>
          </View>
          <Avatar
            size={64}
            handle={other.handle}
            name={other.name}
            uri={other.avatarUrl}
            decorative
          />
          <Text variant="titleMd" align="center" accessibilityRole="header" style={styles.title}>
            {COPY.sheetTitle(first)}
          </Text>
          <Text variant="bodySm" color="grey" align="center">
            {`@${other.handle} · ${other.name}`}
          </Text>
          <Text variant="bodySm" color="grey" align="center" style={styles.confirm}>
            {COPY.sheetConfirm(first)}
          </Text>
          <View style={styles.actions}>
            <Button
              fullWidth
              label={acceptByQr ? COPY.acceptByQr : COPY.accept}
              {...(acceptByQr ? { icon: 'scan-line' as const } : {})}
              loading={busy}
              onPress={onAccept}
            />
            <Button
              fullWidth
              variant="secondary"
              label={COPY.decline}
              disabled={busy}
              onPress={onDecline}
            />
          </View>
          {error === null ? null : (
            <Text
              variant="bodySm"
              color="danger"
              align="center"
              accessibilityLiveRegion="polite"
              testID="folha-pedido-erro"
            >
              {error}
            </Text>
          )}
          <Text variant="caption" color="grey" align="center" testID="folha-pedido-prazo">
            {COPY.expiresIn(formatCountdown(secondsLeft))}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.overlay },
  sheet: {
    alignItems: 'center',
    gap: theme.space[6],
    paddingHorizontal: theme.layout.screenX,
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    backgroundColor: theme.colors.white,
    boxShadow: theme.shadow.sheet,
  },
  topRow: { alignSelf: 'stretch', alignItems: 'center', minHeight: theme.layout.hitMin },
  grabber: {
    marginTop: theme.space[8],
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.colors.border,
  },
  close: { position: 'absolute', right: -theme.space[8], top: 0 },
  title: { marginTop: theme.space[8] },
  confirm: { maxWidth: 300 },
  actions: { alignSelf: 'stretch', gap: theme.space[8], marginTop: theme.space[12] },
});
