import type { ConnectionRequest } from '@sussurro/shared';
import { Avatar, Button, IconButton, Text, theme, useReducedMotion } from '@sussurro/ui';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAnnounceOnIos, useFocusOnShow } from './a11y';
import { COPY, firstName, formatCountdown } from './copy';
import type { NfcRole } from './useConnectSession';
import { BLOCK_ACTION, REPORT_ACTION } from '../moderation/useModerationMenu';

export interface IncomingRequestSheetProps {
  request: ConnectionRequest;
  secondsLeft: number;
  /** Mensagem do aceite que não deu certo (o pedido continua valendo). */
  error: string | null;
  busy: boolean;
  /** Depois do "Aceitar": a folha pede a leitura do código de quem pediu (D7). */
  reading: boolean;
  /** O NFC deste celular, para dizer como ler (ADR 0013 §5). */
  nfc: { role: NfcRole; enabled: boolean };
  onAccept: () => void;
  onDecline: () => void;
  /** iPhone: "Aproximar do outro celular" (a folha do sistema). */
  onTapNfc: () => void;
  /** Android com o NFC desligado: "Ligar NFC". */
  onTurnOnNfc: () => void;
  onUseCamera: () => void;
  onBlock: () => void;
  onReport: () => void;
  /** Fecha sem responder (✕ ou voltar do Android): o pedido segue valendo até vencer. */
  onClose: () => void;
}

/**
 * Folha "Helena quer se conectar" (ux.md §4.11, 4.6 CA1): avatar, nome, @, Aceitar, Recusar e o
 * tempo restante, que não é anunciado a cada segundo. "Aceitar" pede a leitura do código na tela de
 * quem pediu (D7, ADR 0013 §5): por NFC (no Android, encostando; no iPhone, pelo botão) ou pela
 * câmera. ‹Denunciar› e ‹Bloquear› ficam no fim, num grupo à parte. Uma folha por vez.
 */
export function IncomingRequestSheet({
  request,
  secondsLeft,
  error,
  busy,
  reading,
  nfc,
  onAccept,
  onDecline,
  onTapNfc,
  onTurnOnNfc,
  onUseCamera,
  onBlock,
  onReport,
  onClose,
}: IncomingRequestSheetProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const { other } = request;
  const first = firstName(other.name);
  // O foco vai ao título; o anúncio do pedido sai depois dele (ux.md §11.8).
  const titleRef = useFocusOnShow(request.id);
  const readRef = useFocusOnShow(`${request.id}:ler`, reading);
  // O erro do aceite, no iOS, sai por anúncio: o VoiceOver ignora a região viva (ux.md §11.19, S2).
  useAnnounceOnIos(error);

  let actions;
  if (!reading) {
    actions = (
      <View style={styles.actions}>
        <Button fullWidth label={COPY.accept} loading={busy} onPress={onAccept} />
        <Button
          fullWidth
          variant="secondary"
          label={COPY.decline}
          disabled={busy}
          onPress={onDecline}
        />
      </View>
    );
  } else {
    const nfcOn = nfc.role === 'emitter' && nfc.enabled;
    actions = (
      <View style={styles.actions} testID="folha-pedido-leitura">
        <View ref={readRef} accessible style={styles.readText}>
          <Text variant="bodyStrong" align="center">
            {COPY.acceptRead(first)}
          </Text>
          {nfcOn ? (
            <Text variant="bodySm" color="grey" align="center" testID="folha-pedido-nfc">
              {COPY.acceptReadNfc(first)}
            </Text>
          ) : null}
        </View>
        {nfc.role === 'reader' ? (
          <Button
            fullWidth
            icon="smartphone-nfc"
            label={COPY.nfcTap}
            disabled={busy}
            onPress={onTapNfc}
          />
        ) : null}
        <Button
          fullWidth
          variant={nfc.role === 'none' ? 'primary' : 'secondary'}
          icon="camera"
          label={COPY.useCamera}
          loading={busy}
          onPress={onUseCamera}
        />
        {nfc.role === 'emitter' && !nfc.enabled ? (
          <Button
            fullWidth
            variant="secondary"
            label={COPY.turnOnNfc}
            accessibilityHint={COPY.turnOnNfcHint}
            disabled={busy}
            onPress={onTurnOnNfc}
          />
        ) : null}
        <Button
          fullWidth
          variant="link"
          size="sm"
          label={COPY.decline}
          disabled={busy}
          onPress={onDecline}
        />
      </View>
    );
  }

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
          <View
            ref={titleRef}
            accessible
            accessibilityRole="header"
            style={styles.title}
            testID="folha-pedido-titulo"
          >
            <Text variant="titleMd" align="center">
              {COPY.sheetTitle(first)}
            </Text>
          </View>
          <Text variant="bodySm" color="grey" align="center">
            {`@${other.handle} · ${other.name}`}
          </Text>
          <Text variant="bodySm" color="grey" align="center" style={styles.confirm}>
            {COPY.sheetConfirm(first)}
          </Text>
          {actions}
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
          <Text
            variant="caption"
            color="grey"
            align="center"
            accessibilityLiveRegion="none"
            testID="folha-pedido-prazo"
          >
            {COPY.expiresIn(formatCountdown(secondsLeft))}
          </Text>
          <View style={styles.moderation}>
            <Button
              variant="link"
              size="sm"
              label={REPORT_ACTION}
              disabled={busy}
              onPress={onReport}
              testID="folha-pedido-denunciar"
            />
            <Button
              variant="link"
              size="sm"
              label={BLOCK_ACTION}
              disabled={busy}
              onPress={onBlock}
              testID="folha-pedido-bloquear"
            />
          </View>
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
  readText: { alignItems: 'center', gap: theme.space[4] },
  // ‹Denunciar› ‹Bloquear›: dois `link sm` centralizados, num grupo à parte (ux.md §11.14).
  moderation: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    columnGap: theme.space[32],
    rowGap: theme.space[8],
    marginTop: theme.space[8],
  },
});
