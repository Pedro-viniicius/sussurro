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
  TouchHint,
  type TouchHintPose,
  useReducedMotion,
} from '@sussurro/ui';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useFocusOnShow } from './a11y';
import { COPY, firstName, formatConnectedDate } from './copy';
import type { HaltReason } from './errors';
import { useAppActive } from './hooks';
import { IncomingRequestSheet } from './IncomingRequestSheet';
import { QrScanner } from './QrScanner';
import { connectTiming } from './timing';
import { TouchCard } from './TouchCard';
import { type ConnectMode, type ConnectSession, useConnectSession } from './useConnectSession';
import type { TouchPhase } from './useTouch';
import { ReportForm } from '../moderation/ReportForm';
import { ROUTES } from '../navigation/routes';

const MODES = [
  { key: 'touch', label: COPY.modeTouch },
  { key: 'qr', label: COPY.modeQr },
] as const satisfies readonly { key: ConnectMode; label: string }[];

/** Telas com menos de 700 pt de altura (iPhone SE): a ilustração compacta (ux.md §11.7). */
const COMPACT_BELOW_HEIGHT = 700;

/** Android ≤ 11 (API ≤ 30): o sistema chama a permissão de Bluetooth de localização (T24). */
const LEGACY_ANDROID =
  Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version <= 30;

function Header() {
  return (
    <View style={styles.header}>
      <Text variant="titleLg" accessibilityRole="header">
        {COPY.title}
      </Text>
    </View>
  );
}

function ModeSelector({ session }: { session: ConnectSession }) {
  return (
    <SegmentedControl
      options={MODES}
      value={session.mode}
      onChange={session.actions.setMode}
      accessibilityLabel={COPY.modeGroup}
      testID="seletor-conectar"
    />
  );
}

/** Só no build de desenvolvimento (D15): simulações e a calibração do encostar. */
function DevLinks({ session, touch }: { session: ConnectSession; touch: boolean }) {
  if (!session.simulationEnabled) return null;
  return (
    <View style={styles.centered}>
      <Button variant="link" size="sm" label={COPY.simulate} onPress={session.actions.simulate} />
      {touch ? (
        <>
          <Button
            variant="link"
            size="sm"
            label={COPY.simulateTouch}
            onPress={session.actions.simulateTouch}
          />
          <Button
            variant="link"
            size="sm"
            label={COPY.calibration}
            onPress={session.actions.openCalibration}
          />
        </>
      ) : null}
    </View>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.stateBlock}>{children}</View>;
}

/** Verificando (1): a área do estado fica vazia; o Spinner 20 só aparece depois de 300 ms. */
function Checking() {
  const [showSpinner, setShowSpinner] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSpinner(true);
    }, connectTiming.checkingSpinnerMs);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return (
    <View style={styles.stack} testID="conectar-verificando">
      <View style={styles.spinner}>
        {showSpinner ? (
          <ActivityIndicator
            size={20}
            color={theme.colors.grey}
            testID="conectar-verificando-spinner"
          />
        ) : null}
      </View>
    </View>
  );
}

const PHASE_TEST_ID: Record<TouchPhase, string> = {
  idle: 'conectar-pronto',
  approaching: 'conectar-aproximando',
  confirming: 'conectar-confirmando',
  notConfirmed: 'conectar-nao-deu',
  noTouch: 'conectar-pronto',
};

function poseFor(phase: TouchPhase): TouchHintPose {
  if (phase === 'approaching') return 'approaching';
  if (phase === 'confirming') return 'touching';
  return 'demo';
}

/** A nota de privacidade (T43, no lugar do T6), com o cadeado. */
function PrivacyNote() {
  return (
    <View style={styles.note}>
      <Icon name="lock" size={theme.size.icon.inline} color="grey" />
      <Text variant="caption" color="grey" style={styles.noteText}>
        {COPY.privacyNote}
      </Text>
    </View>
  );
}

/** "Não está dando certo?" (10): o QR em destaque, no lugar do T5 e da nota (P9). */
function QrHint({ session }: { session: ConnectSession }) {
  return (
    <View style={styles.hint} testID="conectar-dica-qr">
      <Text variant="bodyStrong">{COPY.nobodyTitle}</Text>
      <Text variant="bodySm" color="greyStrong">
        {COPY.nobodyText}
      </Text>
      <Button size="sm" icon="qr-code" label={COPY.useQr} onPress={session.actions.useQr} />
    </View>
  );
}

/**
 * Pronto (6) e as suas fases: Aproximando (7), Confirmando (8), "Não deu para confirmar" (9) e Nada
 * detectado (10). Nenhuma fase mostra nome, foto, @, distância nem quantas pessoas estão por perto.
 */
function Ready({ session }: { session: ConnectSession }) {
  const { phase, demoRun } = session.touch;
  const { height } = useWindowDimensions();
  // O foco vai ao título do estado só quando o controle focado sumiu da tela (Cancelar, cartão
  // vencido, "Tentar de novo"…). Na abertura, pelo seletor e na volta do background, fica onde está
  // (ux.md §11.8, WCAG 3.2.2).
  const titleRef = useFocusOnShow(session.readyFocus.key, session.readyFocus.enabled);
  let title: string = COPY.readyTitle;
  if (phase === 'approaching') title = COPY.approachingTitle;
  else if (phase === 'confirming') title = COPY.confirmingTitle;

  let body: ReactNode;
  switch (phase) {
    case 'approaching':
      body = (
        <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
          {COPY.approachingText}
        </Text>
      );
      break;
    case 'confirming':
      body = (
        <View style={styles.row}>
          <ActivityIndicator size={16} color={theme.colors.grey} />
          <Text variant="bodySm" color="grey">
            {COPY.confirmingText}
          </Text>
        </View>
      );
      break;
    case 'notConfirmed':
      body = (
        <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
          {COPY.touchFailed}
        </Text>
      );
      break;
    case 'idle':
    case 'noTouch':
      body =
        phase === 'noTouch' ? null : (
          <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
            {COPY.readyText}
          </Text>
        );
      break;
  }

  return (
    <View style={styles.stack} testID={PHASE_TEST_ID[phase]}>
      {/* A demonstração roda de novo a cada volta ao Pronto (nova montagem). */}
      <TouchHint
        key={demoRun}
        pose={poseFor(phase)}
        compact={height < COMPACT_BELOW_HEIGHT}
        testID="ilustracao-encostar"
      />
      <Centered>
        <View ref={titleRef} accessible accessibilityRole="header" testID="conectar-titulo">
          <Text variant="titleMd" align="center">
            {title}
          </Text>
        </View>
        {body}
      </Centered>
      {phase === 'noTouch' ? <QrHint session={session} /> : <PrivacyNote />}
      <DevLinks session={session} touch />
    </View>
  );
}

/** "QR code": meu código (o `qrToken`), renovado a cada 20 s sem piscar (4.7 CA1). */
function QrStart({ session }: { session: ConnectSession }) {
  const { user, tokens } = session;
  return (
    <View style={styles.stack} testID="conectar-qr">
      {session.unsupported ? (
        <View style={styles.banner} testID="conectar-sem-suporte-faixa">
          <Text variant="bodySm" color="greyStrong">
            {COPY.unsupportedBanner}
          </Text>
        </View>
      ) : null}
      <Text variant="bodySm" color="grey" align="center">
        {COPY.qrExplain}
      </Text>
      <QRCodeCard
        value={tokens === null ? null : proximityQrPayload(tokens.qrToken)}
        handle={user.handle}
        name={user.name}
        avatarSeed={user.id}
        avatarUri={user.avatarUrl}
      />
      <Text variant="bodySm" color="grey" align="center">
        {COPY.qrHint}
      </Text>
      <Button
        fullWidth
        icon="scan-line"
        label={COPY.readTheirCode}
        onPress={session.actions.openScanner}
      />
      <DevLinks session={session} touch={false} />
    </View>
  );
}

/** O cartão (11, 12, 14 e o Bloqueado), sem a introdução e sem o seletor. */
function Card({ session }: { session: ConnectSession }) {
  const { view, cardIncoming, cardActions, actions } = session;
  if (view.kind !== 'card' || cardActions === null) return null;
  const { person } = view.card;
  // O Conectar ou o Aceitar em andamento desativam a linha, como o ‹Cancelar› (ux.md §11.14).
  const busy = cardIncoming === null ? session.busy === person.handle : cardIncoming.busy;
  const common = {
    focusRun: cardActions.focusRun,
    focusHeld: cardActions.focusHeld,
    moderation: {
      visible: cardActions.lineVisible,
      canBlock: !cardActions.blocked,
      blocking: cardActions.blocking,
      disabled: busy,
      onReport: actions.reportCard,
      onBlock: actions.blockCard,
    },
  };
  if (cardActions.blocked) {
    return <TouchCard variant="blocked" person={person} onBack={actions.closeCard} {...common} />;
  }
  if (cardIncoming !== null) {
    return (
      <TouchCard
        variant="incoming"
        person={cardIncoming.request.other}
        secondsLeft={cardIncoming.secondsLeft}
        busy={cardIncoming.busy}
        error={cardIncoming.error}
        onAccept={actions.accept}
        onDecline={actions.decline}
        {...common}
      />
    );
  }
  if (view.alreadyConnected) {
    return (
      <TouchCard
        variant="alreadyConnected"
        person={person}
        onBack={actions.closeCard}
        {...common}
      />
    );
  }
  return (
    <TouchCard
      variant="touched"
      person={person}
      busy={busy}
      onConnect={actions.connectCard}
      onCancel={actions.closeCard}
      {...common}
    />
  );
}

/**
 * O formulário de denúncia por cima do cartão (ux.md §11.14, M8): o mesmo da rota `/denunciar`, num
 * `Modal` de tela cheia dentro da sessão do Conectar (abrir a rota desmontaria a sessão e o cartão).
 * O erro do envio fica numa linha do formulário, porque o Toast ficaria atrás do `Modal`. O "voltar"
 * do Android vale como "Cancelar". O foco vai à pergunta.
 */
function ReportSheet({ session }: { session: ConnectSession }) {
  const { reportForm, actions } = session;
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const questionRef = useFocusOnShow(
    `denunciar:${String(reportForm?.run ?? 0)}`,
    reportForm?.visible === true,
  );
  if (reportForm === null) return null;
  return (
    <Modal
      visible={reportForm.visible}
      animationType={reduceMotion ? 'none' : 'slide'}
      presentationStyle="fullScreen"
      onRequestClose={actions.cancelReport}
      onDismiss={actions.reportDismissed}
      testID="conectar-denunciar"
    >
      <View
        style={[styles.reportScreen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        accessibilityViewIsModal
      >
        <ReportForm
          key={reportForm.run}
          target={{ type: 'account', handle: reportForm.handle }}
          errorMode="inline"
          note={reportForm.note}
          questionRef={questionRef}
          errorTestID="conectar-denunciar-erro"
          onClose={actions.cancelReport}
          onSent={actions.reportSent}
          onGone={actions.reportGone}
        />
      </View>
    </Modal>
  );
}

/** "Aguardando Caio confirmar" (p13). No QR, o meu código fica na tela para B ler (D7). */
function Waiting({ session }: { session: ConnectSession }) {
  const { view, user, tokens } = session;
  if (view.kind !== 'waiting') return null;
  const { other, method } = view.request;
  const first = firstName(other.name);
  return (
    <View style={styles.section} testID="conectar-aguardando">
      <PairAvatars
        state="waiting"
        left={{ handle: user.handle, name: user.name, seed: user.id, uri: user.avatarUrl }}
        right={{ handle: other.handle, name: other.name, uri: other.avatarUrl }}
      />
      <Centered>
        <Text variant="titleMd" align="center" accessibilityRole="header">
          {COPY.waitingTitle(first)}
        </Text>
        <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
          {COPY.waitingText(first)}
        </Text>
      </Centered>
      {method === 'qr' ? (
        <>
          <QRCodeCard
            value={tokens === null ? null : proximityQrPayload(tokens.qrToken)}
            handle={user.handle}
            name={user.name}
            avatarSeed={user.id}
            avatarUri={user.avatarUrl}
          />
          <Text variant="bodySmStrong" align="center">
            {COPY.waitingQr(first)}
          </Text>
        </>
      ) : null}
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
  const { other, method } = view.request;
  return (
    <View style={styles.section} testID="conectar-nao-confirmou">
      <PairAvatars
        state="notConfirmed"
        left={{ handle: user.handle, name: user.name, seed: user.id, uri: user.avatarUrl }}
        right={{ handle: other.handle, name: other.name, uri: other.avatarUrl }}
      />
      <Centered>
        <Text variant="titleMd" align="center" accessibilityRole="header">
          {COPY.notConfirmedTitle(firstName(other.name))}
        </Text>
        <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
          {COPY.notConfirmedText(method)}
        </Text>
      </Centered>
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
      <Centered>
        <View ref={titleRef} accessible accessibilityRole="header" testID="conectados-titulo">
          <Text variant="titleMd" align="center">
            {COPY.connectedTitle(firstName(other.name))}
          </Text>
        </View>
        <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
          {`${COPY.connectedSince(formatConnectedDate(view.at))}\n${COPY.connectedText}`}
        </Text>
      </Centered>
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

/** Estados de Bluetooth (ux.md §11.4, 2 a 5), sempre com a saída pelo QR (4.3 CA4). */
function BluetoothState({ session }: { session: ConnectSession }) {
  const { view, actions } = session;
  const useQr = { label: COPY.useQr, onPress: actions.useQr };
  switch (view.kind) {
    case 'btExplain':
      return (
        <EmptyState
          icon="bluetooth"
          title={COPY.btExplainTitle}
          description={
            LEGACY_ANDROID ? `${COPY.btExplainText}\n\n${COPY.btExplainLegacy}` : COPY.btExplainText
          }
          primaryAction={{ label: COPY.continue, onPress: actions.requestBluetooth }}
          secondaryAction={useQr}
          testID="bt-explicacao"
        />
      );
    case 'btDenied':
      return (
        <EmptyState
          icon="bluetooth-off"
          title={COPY.btDeniedTitle}
          description={COPY.btDeniedText}
          primaryAction={{ label: COPY.openSettings, onPress: actions.openSettings }}
          secondaryAction={useQr}
          testID="bt-negado"
        />
      );
    case 'btOff':
      return (
        <EmptyState
          icon="bluetooth-off"
          title={COPY.btOffTitle}
          description={COPY.btOffText}
          primaryAction={
            Platform.OS === 'android'
              ? { label: COPY.turnOnBluetooth, onPress: actions.turnOnBluetooth }
              : { label: COPY.openSettings, onPress: actions.openSettings }
          }
          secondaryAction={useQr}
          testID="bt-desligado"
        />
      );
    case 'btLocationOff':
      return (
        <EmptyState
          icon="bluetooth-off"
          title={COPY.locationOffTitle}
          description={COPY.locationOffText}
          primaryAction={{ label: COPY.openSettings, onPress: actions.openSettings }}
          secondaryAction={useQr}
          testID="bt-localizacao"
        />
      );
    case 'btUnsupported':
      return (
        <EmptyState
          icon="bluetooth-off"
          title={COPY.btUnavailableTitle}
          description={COPY.btUnavailableText}
          primaryAction={useQr}
          testID="conectar-sem-suporte"
        />
      );
    case 'checking':
    case 'ready':
    case 'card':
    case 'waiting':
    case 'notConfirmed':
    case 'connected':
      return null;
  }
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

/**
 * Verificando (1), Pronto (6 a 10) e QR. A introdução (T1, só no Encostar) e o seletor ficam
 * montados fora da troca de estados: quem escolhe "QR code" ou "Encostar" continua com o foco no
 * segmento (ux.md §11.8, WCAG 3.2.2 e 2.4.3).
 */
function Start({ session }: { session: ConnectSession }) {
  const { mode, view } = session;
  let content: ReactNode;
  if (mode === 'qr') content = <QrStart session={session} />;
  else if (view.kind === 'checking') content = <Checking />;
  else content = <Ready session={session} />;
  return (
    <View style={styles.section}>
      {mode === 'touch' ? (
        <Text variant="bodySm" color="grey" align="center">
          {COPY.intro}
        </Text>
      ) : null}
      <ModeSelector session={session} />
      {content}
    </View>
  );
}

function Body({ session }: { session: ConnectSession }) {
  const { view, halt, mode } = session;
  if (halt !== null) return <Halted reason={halt} session={session} />;
  switch (view.kind) {
    case 'waiting':
      return <Waiting session={session} />;
    case 'notConfirmed':
      return <NotConfirmed session={session} />;
    case 'connected':
      return <Connected session={session} />;
    case 'card':
      return <Card session={session} />;
    case 'btExplain':
    case 'btDenied':
    case 'btOff':
    case 'btLocationOff':
    case 'btUnsupported':
      if (mode === 'touch') return <BluetoothState session={session} />;
      break;
    case 'checking':
    case 'ready':
      break;
  }
  return <Start session={session} />;
}

interface ConnectSessionViewProps {
  live: boolean;
  qrParam: string | null;
  isQrHandled: (token: string) => boolean;
  onQrHandled: (token: string) => void;
}

function ConnectSessionView(props: ConnectSessionViewProps) {
  const session = useConnectSession(props);
  const { incoming, scanner, actions } = session;

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
          acceptByQr={incoming.acceptByQr}
          onAccept={actions.accept}
          onDecline={actions.decline}
          onClose={actions.closeSheet}
        />
      ) : null}
      {scanner === null ? null : (
        <QrScanner
          error={scanner.error}
          busy={scanner.busy}
          onRead={actions.onScanned}
          onClose={actions.closeScanner}
          onShowMyCode={actions.showMyCode}
        />
      )}
      <ReportSheet session={session} />
    </>
  );
}

/**
 * Aba Conectar (ux.md §11, "encostar os celulares"; QR de reserva). A sessão só existe com a aba
 * em foco: ao sair da aba, tudo para (anúncio, varredura, relato, polling e tokens) e a volta
 * começa no Verificando. Em background, tudo pausa (o nativo também para o anúncio e a varredura)
 * e recomeça ao voltar, no mesmo estado (4.3 CA3): no Android, até o pedido de permissão manda o
 * app para o background.
 */
export function ConnectScreen() {
  const focused = useIsFocused();
  const { qr } = useLocalSearchParams<{ qr?: string }>();
  const live = useAppActive();
  // Deep link já tratado: voltar à aba ou recomeçar a sessão não pede de novo.
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
  /** O conteúdo de cada estado dentro da `section` do Verificando, do Pronto e do QR. */
  stack: { gap: theme.space[16] },
  centered: { alignItems: 'center', gap: theme.space[12] },
  stateBlock: { alignItems: 'center', gap: theme.space[8] },
  stateText: { maxWidth: 320 },
  spinner: { minHeight: 216, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space[8] },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: theme.space[6],
  },
  noteText: { flexShrink: 1, maxWidth: 300 },
  hint: {
    gap: theme.space[8],
    padding: theme.space[16],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.greySoft,
  },
  banner: {
    padding: theme.space[12],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.greySoft,
  },
  reportScreen: { flex: 1, backgroundColor: theme.colors.white },
});
