import { proximityQrPayload } from '@sussurro/shared';
import {
  Button,
  EmptyState,
  Icon,
  PairAvatars,
  QRCodeCard,
  SegmentedControl,
  Text,
  theme,
  useReducedMotion,
} from '@sussurro/ui';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAnnounceOnIos, useFocusOnShow } from './a11y';
import { COPY, firstName, formatConnectedDate } from './copy';
import type { HaltReason } from './errors';
import { useAppActive } from './hooks';
import { IncomingRequestSheet } from './IncomingRequestSheet';
import { PersonCard } from './PersonCard';
import { QrScanner } from './QrScanner';
import { type ConnectMode, type ConnectSession, useConnectSession } from './useConnectSession';
import { ReportForm } from '../moderation/ReportForm';
import { ROUTES } from '../navigation/routes';

const MODES = [
  { key: 'show', label: COPY.modeShow },
  { key: 'read', label: COPY.modeRead },
] as const satisfies readonly { key: ConnectMode; label: string }[];

function Header() {
  return (
    <View style={styles.header}>
      <Text variant="titleLg" accessibilityRole="header">
        {COPY.title}
      </Text>
    </View>
  );
}

/** Só no build de desenvolvimento (D15): pedidos simulados de uma persona do seed. */
function DevLinks({ session }: { session: ConnectSession }) {
  if (!session.simulationEnabled) return null;
  return (
    <View style={styles.centered}>
      <Button variant="link" size="sm" label={COPY.simulate} onPress={session.actions.simulate} />
      <Button
        variant="link"
        size="sm"
        label={COPY.simulateNfc}
        onPress={session.actions.simulateNfc}
      />
    </View>
  );
}

/**
 * O NFC ao lado do meu QR (ADR 0013 §5): com o NFC ligado, o `emitHint` (o código sai também por
 * NFC; no "Aguardando", o `hint` diz que quem lê é quem toca em Aceitar); desligado, o aviso com
 * "Ligar NFC". No iPhone e sem NFC, nada (o iPhone não emite).
 */
function EmitStatus({ session, hint = COPY.emitHint }: { session: ConnectSession; hint?: string }) {
  const { nfc, actions } = session;
  if (nfc.role !== 'emitter') return null;
  if (nfc.enabled) {
    return (
      <View style={styles.row} testID="conectar-nfc-emitindo">
        <Icon name="smartphone-nfc" size={theme.size.icon.inline} color="grey" />
        <Text variant="bodySm" color="greyStrong" style={styles.rowText}>
          {hint}
        </Text>
      </View>
    );
  }
  return <NfcOff onTurnOn={actions.turnOnNfc} />;
}

function NfcOff({ onTurnOn }: { onTurnOn: () => void }) {
  return (
    <View style={styles.notice} testID="conectar-nfc-desligado">
      <Text variant="bodyStrong">{COPY.nfcOffTitle}</Text>
      <Text variant="bodySm" color="greyStrong">
        {COPY.nfcOffText}
      </Text>
      <Button
        size="sm"
        variant="secondary"
        label={COPY.turnOnNfc}
        accessibilityHint={COPY.turnOnNfcHint}
        onPress={onTurnOn}
      />
    </View>
  );
}

/** Mostrar meu código (padrão): o QR com o avatar e o @, renovado a cada 20 s sem piscar. */
function ShowMyCode({ session }: { session: ConnectSession }) {
  const { user, token } = session;
  return (
    <View style={styles.stack} testID="conectar-mostrar">
      <QRCodeCard
        value={token === null ? null : proximityQrPayload(token)}
        handle={user.handle}
        name={user.name}
        avatarSeed={user.id}
        avatarUri={user.avatarUrl}
      />
      <Text variant="bodySm" color="grey" align="center">
        {COPY.qrHint}
      </Text>
      <EmitStatus session={session} />
    </View>
  );
}

/**
 * Ler código (ADR 0013 §5): no Android com NFC, a leitura fica ligada enquanto o modo está aberto;
 * no iPhone, "Aproximar do outro celular" abre a folha do sistema; nos dois e sem NFC, "Usar a
 * câmera".
 */
function ReadCode({ session }: { session: ConnectSession }) {
  const { nfc, actions, resolving, readNotice } = session;
  useAnnounceOnIos(readNotice);
  const nfcReady = nfc.role === 'emitter' && nfc.enabled;
  let title: string = COPY.readCameraOnlyTitle;
  let text: string = COPY.readCameraOnlyText;
  if (nfcReady) {
    title = COPY.readNfcTitle;
    text = COPY.readNfcText;
  } else if (nfc.role === 'reader') {
    title = COPY.readIphoneTitle;
    text = COPY.readIphoneText;
  }
  return (
    <View style={styles.stack} testID="conectar-ler">
      <View style={styles.readIcon}>
        <Icon name={nfc.role === 'none' ? 'scan-line' : 'smartphone-nfc'} size={40} color="blue" />
      </View>
      <View style={styles.stateBlock}>
        <Text
          variant="titleMd"
          align="center"
          accessibilityRole="header"
          testID="conectar-ler-titulo"
        >
          {title}
        </Text>
        <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
          {text}
        </Text>
      </View>
      {nfc.role === 'emitter' && !nfc.enabled ? <NfcOff onTurnOn={actions.turnOnNfc} /> : null}
      {resolving ? (
        // Sem região viva: o `announce` do "Código lido" já anuncia (ux.md §11.19, S5).
        <View style={[styles.row, styles.centeredRow]} testID="conectar-lendo">
          <ActivityIndicator size={16} color={theme.colors.grey} />
          <Text variant="bodySm" color="grey">
            {COPY.codeRead}
          </Text>
        </View>
      ) : null}
      {readNotice === null ? null : (
        <Text
          variant="bodySm"
          color="danger"
          align="center"
          accessibilityLiveRegion="polite"
          testID="conectar-ler-aviso"
        >
          {readNotice}
        </Text>
      )}
      {nfc.role === 'reader' ? (
        <Button
          fullWidth
          icon="smartphone-nfc"
          label={COPY.nfcTap}
          disabled={resolving}
          onPress={actions.tapNfc}
        />
      ) : null}
      <Button
        fullWidth
        variant={nfc.role === 'none' ? 'primary' : 'secondary'}
        icon="camera"
        label={COPY.useCamera}
        disabled={resolving}
        onPress={actions.openScanner}
      />
    </View>
  );
}

/**
 * O início: a introdução, o seletor e o modo. O seletor fica montado fora da troca de modo: quem
 * troca de modo continua com o foco no segmento (ux.md §11.8, WCAG 3.2.2 e 2.4.3).
 */
function Start({ session }: { session: ConnectSession }) {
  const titleRef = useFocusOnShow(session.startFocus.key, session.startFocus.enabled);
  return (
    <View style={styles.section}>
      <View ref={titleRef} accessible testID="conectar-titulo">
        <Text variant="bodySm" color="grey" align="center">
          {COPY.intro}
        </Text>
      </View>
      <SegmentedControl
        options={MODES}
        value={session.mode}
        onChange={session.actions.setMode}
        accessibilityLabel={COPY.modeGroup}
        testID="seletor-conectar"
      />
      {session.mode === 'show' ? <ShowMyCode session={session} /> : <ReadCode session={session} />}
      <DevLinks session={session} />
    </View>
  );
}

/** O formulário de denúncia aberto pela folha do pedido (ux.md §11.14): a sessão continua montada. */
function ReportSheet({ session }: { session: ConnectSession }) {
  const { report, actions } = session;
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const questionRef = useFocusOnShow(`denunciar:${String(report?.run ?? 0)}`, report !== null);
  if (report === null) return null;
  return (
    <Modal
      visible
      animationType={reduceMotion ? 'none' : 'slide'}
      presentationStyle="fullScreen"
      onRequestClose={actions.closeReport}
      testID="conectar-denunciar"
    >
      <View
        style={[styles.reportScreen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        accessibilityViewIsModal
      >
        <ReportForm
          key={report.run}
          target={{ type: 'account', handle: report.handle }}
          questionRef={questionRef}
          errorTestID="conectar-denunciar-erro"
          onClose={actions.closeReport}
          onSent={actions.reportSent}
          onGone={actions.reportGone}
        />
      </View>
    </Modal>
  );
}

/**
 * "Aguardando Caio confirmar" (p13): o meu código fica na tela, no QR e no NFC, para Caio ler e
 * confirmar (D7).
 */
function Waiting({ session }: { session: ConnectSession }) {
  const { view, user, token } = session;
  if (view.kind !== 'waiting') return null;
  const { other } = view.request;
  const first = firstName(other.name);
  return (
    <View style={styles.section} testID="conectar-aguardando">
      <PairAvatars
        state="waiting"
        left={{ handle: user.handle, name: user.name, seed: user.id, uri: user.avatarUrl }}
        right={{ handle: other.handle, name: other.name, uri: other.avatarUrl }}
      />
      <View style={styles.stateBlock}>
        <Text variant="titleMd" align="center" accessibilityRole="header">
          {COPY.waitingTitle(first)}
        </Text>
        <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
          {COPY.waitingText(first)}
        </Text>
      </View>
      <QRCodeCard
        value={token === null ? null : proximityQrPayload(token)}
        handle={user.handle}
        name={user.name}
        avatarSeed={user.id}
        avatarUri={user.avatarUrl}
      />
      <Text variant="bodySmStrong" align="center">
        {COPY.waitingQr(first)}
      </Text>
      <EmitStatus session={session} hint={COPY.waitingEmitHint(first)} />
      <View style={styles.centered}>
        <Button
          size="sm"
          variant="secondary"
          label={COPY.cancelRequest}
          loading={session.busy === 'cancel'}
          onPress={session.actions.cancelRequest}
        />
      </View>
    </View>
  );
}

function NotConfirmed({ session }: { session: ConnectSession }) {
  const { view, user } = session;
  if (view.kind !== 'notConfirmed') return null;
  const { other } = view.request;
  return (
    <View style={styles.section} testID="conectar-nao-confirmou">
      <PairAvatars
        state="notConfirmed"
        left={{ handle: user.handle, name: user.name, seed: user.id, uri: user.avatarUrl }}
        right={{ handle: other.handle, name: other.name, uri: other.avatarUrl }}
      />
      <View style={styles.stateBlock}>
        <Text variant="titleMd" align="center" accessibilityRole="header">
          {COPY.notConfirmedTitle(firstName(other.name))}
        </Text>
        <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
          {COPY.notConfirmedText}
        </Text>
      </View>
      <View style={styles.centered}>
        <Button size="sm" label={COPY.tryAgain} onPress={session.actions.retryAfterNotConfirmed} />
        <Button size="sm" variant="link" label={COPY.back} onPress={session.actions.backToStart} />
      </View>
    </View>
  );
}

function Connected({ session }: { session: ConnectSession }) {
  const { view, user } = session;
  const titleRef = useFocusOnShow(view.kind === 'connected' ? view.other.handle : '');
  if (view.kind !== 'connected') return null;
  const { other } = view;
  return (
    <View style={styles.section} testID="conectar-conectados">
      <PairAvatars
        state="connected"
        left={{ handle: user.handle, name: user.name, seed: user.id, uri: user.avatarUrl }}
        right={{ handle: other.handle, name: other.name, uri: other.avatarUrl }}
      />
      <View style={styles.stateBlock}>
        <View ref={titleRef} accessible accessibilityRole="header" testID="conectados-titulo">
          <Text variant="titleMd" align="center">
            {COPY.connectedTitle(firstName(other.name))}
          </Text>
        </View>
        <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
          {`${COPY.connectedSince(formatConnectedDate(view.at))}\n${COPY.connectedText}`}
        </Text>
      </View>
      <Button
        fullWidth
        label={COPY.goHome}
        onPress={() => {
          router.navigate(ROUTES.personalHome);
        }}
      />
      <View style={styles.centered}>
        <Button
          variant="link"
          size="sm"
          label={COPY.connectAnother}
          onPress={session.actions.backToStart}
        />
      </View>
    </View>
  );
}

/** Estados que param a tela (ux.md §5.2; 18 a 20): "Tentar de novo" recomeça. */
function Halted({ reason, session }: { reason: HaltReason; session: ConnectSession }) {
  const retry = { label: COPY.tryAgain, onPress: session.actions.resume };
  switch (reason) {
    case 'paused':
      return (
        <EmptyState
          icon="clock"
          title={COPY.pausedTitle}
          description={COPY.pausedText}
          primaryAction={retry}
          testID="conectar-pausado"
        />
      );
    case 'unavailable':
      return (
        <EmptyState
          icon="circle-alert"
          title={COPY.unavailableTitle}
          description={COPY.unavailableText}
          primaryAction={retry}
          testID="conectar-indisponivel"
        />
      );
    case 'offline':
      return (
        <EmptyState
          icon="wifi-off"
          title={COPY.offlineTitle}
          description={COPY.offlineText}
          primaryAction={retry}
          testID="conectar-offline"
        />
      );
    case 'emailNotVerified':
      return (
        <EmptyState
          icon="lock"
          title={COPY.emailTitle}
          description={COPY.emailText}
          primaryAction={{
            label: COPY.verifyEmail,
            onPress: () => {
              router.push(ROUTES.verifyEmail);
            },
          }}
          secondaryAction={retry}
          testID="conectar-email"
        />
      );
  }
}

function Body({ session }: { session: ConnectSession }) {
  const { view, halt, actions } = session;
  if (halt !== null) return <Halted reason={halt} session={session} />;
  switch (view.kind) {
    case 'waiting':
      return <Waiting session={session} />;
    case 'notConfirmed':
      return <NotConfirmed session={session} />;
    case 'connected':
      return <Connected session={session} />;
    case 'card':
      return (
        <PersonCard
          person={view.person}
          busy={session.busy === 'connect'}
          onConnect={actions.connectCard}
          onBack={actions.closeCard}
        />
      );
    case 'start':
      return <Start session={session} />;
  }
}

interface ConnectSessionViewProps {
  live: boolean;
  qrParam: string | null;
  isQrHandled: (token: string) => boolean;
  onQrHandled: (token: string) => void;
}

function ConnectSessionView(props: ConnectSessionViewProps) {
  const session = useConnectSession(props);
  const { incoming, scanner, actions, nfc } = session;
  const accepting = scanner?.purpose.kind === 'accept';
  const acceptFirst =
    scanner?.purpose.kind === 'accept' ? firstName(scanner.purpose.request.other.name) : undefined;
  const acceptHint = acceptFirst === undefined ? undefined : COPY.scannerHintAccept(acceptFirst);
  // N28: no aceite, a câmera negada aponta o caminho certo (ler o código de quem pediu).
  const acceptDenied =
    acceptFirst === undefined ? undefined : COPY.cameraDeniedTextAccept(acceptFirst);

  return (
    <>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Body session={session} />
      </ScrollView>
      {incoming !== null ? (
        <IncomingRequestSheet
          request={incoming.request}
          secondsLeft={incoming.secondsLeft}
          error={incoming.error}
          busy={incoming.busy}
          reading={incoming.reading}
          nfc={nfc}
          onAccept={actions.accept}
          onDecline={actions.decline}
          onTapNfc={actions.tapNfc}
          onTurnOnNfc={actions.turnOnNfc}
          onUseCamera={actions.openScanner}
          onBlock={actions.blockIncoming}
          onReport={actions.reportIncoming}
          onClose={actions.closeSheet}
        />
      ) : null}
      {scanner === null ? null : (
        <QrScanner
          error={scanner.error}
          busy={scanner.busy}
          hint={acceptHint}
          deniedText={acceptDenied}
          onRead={actions.onScanned}
          onClose={actions.closeScanner}
          // No aceite, mostrar o meu código não ajuda: quem aceita lê o de quem pediu (D7, S7).
          onShowMyCode={accepting ? undefined : actions.showMyCode}
        />
      )}
      <ReportSheet session={session} />
    </>
  );
}

/**
 * Aba Conectar (ADR 0013 §5, NFC e QR code). A sessão só existe com a aba em foco: ao sair da aba,
 * tudo para (o NFC deixa de emitir e de ler, o polling e o token) e a volta começa no início. Em
 * background, o mesmo, e tudo recomeça ao voltar, no mesmo estado (o nativo apaga o código emitido
 * no background, e a tela o emite de novo).
 */
export function ConnectScreen() {
  const focused = useIsFocused();
  const { qr } = useLocalSearchParams<{ qr?: string }>();
  const live = useAppActive();
  // Deep link já tratado: voltar à aba ou recomeçar a sessão não lê de novo.
  const handledQr = useRef<string | null>(null);
  const isQrHandled = useCallback((token: string) => handledQr.current === token, []);
  const onQrHandled = useCallback((token: string) => {
    handledQr.current = token;
  }, []);

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="tela-conectar">
      <Header />
      {focused ? (
        <ConnectSessionView
          live={live}
          qrParam={typeof qr === 'string' && qr !== '' ? qr : null}
          isQrHandled={isQrHandled}
          onQrHandled={onQrHandled}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  header: {
    minHeight: theme.layout.headerHeight,
    justifyContent: 'center',
    paddingHorizontal: theme.layout.screenX,
  },
  content: { paddingBottom: theme.space[32] },
  section: {
    paddingHorizontal: theme.layout.screenX,
    paddingTop: theme.space[16],
    gap: theme.space[16],
  },
  stack: { gap: theme.space[16] },
  centered: { alignItems: 'center', gap: theme.space[12] },
  stateBlock: { alignItems: 'center', gap: theme.space[8] },
  stateText: { maxWidth: 320 },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space[8] },
  centeredRow: { justifyContent: 'center' },
  rowText: { flexShrink: 1 },
  readIcon: { alignItems: 'center', paddingTop: theme.space[16] },
  notice: {
    gap: theme.space[8],
    padding: theme.space[16],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.greySoft,
    alignItems: 'flex-start',
  },
  reportScreen: { flex: 1, backgroundColor: theme.colors.white },
});
