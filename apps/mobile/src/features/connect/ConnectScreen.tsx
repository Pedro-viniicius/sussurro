import { proximityQrPayload } from '@sussurro/shared';
import {
  Avatar,
  Button,
  EmptyState,
  PairAvatars,
  QRCodeCard,
  Radar,
  SegmentedControl,
  Text,
  theme,
  UserRow,
} from '@sussurro/ui';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useRef } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { COPY, firstName, formatConnectedDate } from './copy';
import type { HaltReason } from './errors';
import { useAppActive } from './hooks';
import { IncomingRequestSheet } from './IncomingRequestSheet';
import { QrScanner } from './QrScanner';
import { connectTiming } from './timing';
import { type ConnectMode, type ConnectSession, useConnectSession } from './useConnectSession';
import { ROUTES } from '../navigation/routes';

const MODES = [
  { key: 'ble', label: COPY.modeBluetooth },
  { key: 'qr', label: COPY.modeQr },
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

function SimulateLink({ session }: { session: ConnectSession }) {
  if (!session.simulationEnabled) return null;
  return (
    <View style={styles.centered}>
      <Button variant="link" size="sm" label={COPY.simulate} onPress={session.actions.simulate} />
    </View>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.stateBlock}>{children}</View>;
}

function MyAvatar({ session, size }: { session: ConnectSession; size: 64 }) {
  const { user } = session;
  return (
    <Avatar
      size={size}
      handle={user.handle}
      name={user.name}
      seed={user.id}
      uri={user.avatarUrl}
      decorative
    />
  );
}

/** Inicial (p10, com o seletor do D3). */
function BluetoothStart({ session }: { session: ConnectSession }) {
  return (
    <View style={styles.section} testID="conectar-inicial">
      <Text variant="bodySm" color="grey" align="center">
        {COPY.intro}
      </Text>
      <ModeSelector session={session} />
      <Radar variant="idle" label={COPY.search} onPress={session.actions.startSearch} />
      <Text variant="bodySm" color="grey" align="center">
        {COPY.searchHint}
      </Text>
      <SimulateLink session={session} />
    </View>
  );
}

/** "QR code": meu código, renovado a cada 20 s sem piscar (4.7 CA1). */
function QrStart({ session }: { session: ConnectSession }) {
  const { user, ownToken } = session;
  return (
    <View style={styles.section} testID="conectar-qr">
      <ModeSelector session={session} />
      <QRCodeCard
        value={ownToken === null ? null : proximityQrPayload(ownToken)}
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
      <SimulateLink session={session} />
    </View>
  );
}

function Searching({ session, nobody }: { session: ConnectSession; nobody: boolean }) {
  return (
    <View style={styles.section} testID={nobody ? 'conectar-ninguem' : 'conectar-procurando'}>
      <Radar variant="searching" center={<MyAvatar session={session} size={64} />} />
      <Centered>
        <Text variant="titleMd" align="center" accessibilityRole="header">
          {nobody ? COPY.nobodyTitle : COPY.searching}
        </Text>
        <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
          {nobody ? COPY.nobodyText : COPY.keepOpen}
        </Text>
        {nobody ? <Button size="sm" label={COPY.useQr} onPress={session.actions.useQr} /> : null}
        <Button
          size="sm"
          variant="secondary"
          label={COPY.cancel}
          onPress={session.actions.cancelSearch}
        />
      </Centered>
    </View>
  );
}

/** "Por perto agora" (p12): ordenada pelo sinal, com a faixa do D13. */
function NearbyList({ session }: { session: ConnectSession }) {
  return (
    <View testID="conectar-por-perto">
      <Text variant="titleSm" accessibilityRole="header" style={styles.listTitle}>
        {COPY.nearbyTitle}
      </Text>
      {session.nearby.rows.map((row) => (
        <UserRow
          key={row.handle}
          handle={row.handle}
          name={row.name}
          avatarUri={row.avatarUrl}
          avatarSize={theme.size.avatar.xl}
          subtitle={`${row.name} · ${row.band}`}
          testID={`por-perto-${row.handle}`}
          action={
            row.alreadyConnected ? (
              <Text variant="bodySmStrong" color="grey">
                {COPY.connectedLabel}
              </Text>
            ) : (
              <Button
                size="sm"
                label={COPY.connect}
                accessibilityLabel={`${COPY.connect} com @${row.handle}`}
                loading={session.busy === row.handle}
                disabled={session.busy !== null && session.busy !== row.handle}
                onPress={() => {
                  session.actions.connectTo(row);
                }}
              />
            )
          }
        />
      ))}
      <View style={styles.section}>
        <Text variant="bodySm" color="grey">
          {COPY.nearbyFooter}
        </Text>
        <View style={styles.centered}>
          <Button
            size="sm"
            variant="secondary"
            label={COPY.searchAgain}
            onPress={session.actions.searchAgain}
          />
        </View>
      </View>
    </View>
  );
}

/** "Aguardando Caio confirmar" (p13). No QR, o meu código fica na tela para B ler (D7). */
function Waiting({ session }: { session: ConnectSession }) {
  const { view, user, ownToken } = session;
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
            value={ownToken === null ? null : proximityQrPayload(ownToken)}
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
  const { other } = view.request;
  return (
    <View style={styles.section} testID="conectar-nao-confirmou">
      <PairAvatars
        state="notConfirmed"
        left={{ handle: user.handle, name: user.name, seed: user.id, uri: user.avatarUrl }}
        right={{ handle: other.handle, name: other.name, uri: other.avatarUrl }}
      />
      <EmptyStateBody
        title={COPY.notConfirmedTitle(firstName(other.name))}
        text={COPY.notConfirmedText}
      />
      <View style={styles.centered}>
        <Button size="sm" label={COPY.tryAgain} onPress={session.actions.retryAfterNotConfirmed} />
        <Button size="sm" variant="link" label={COPY.back} onPress={session.actions.backToStart} />
      </View>
    </View>
  );
}

function Connected({ session }: { session: ConnectSession }) {
  const { view, user } = session;
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
        <Text variant="titleMd" align="center" accessibilityRole="header">
          {COPY.connectedTitle(firstName(other.name))}
        </Text>
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

function EmptyStateBody({ title, text }: { title: string; text: string }) {
  return (
    <Centered>
      <Text variant="titleMd" align="center" accessibilityRole="header">
        {title}
      </Text>
      <Text variant="bodySm" color="grey" align="center" style={styles.stateText}>
        {text}
      </Text>
    </Centered>
  );
}

/** Estados de Bluetooth do ux.md §4.12, sempre com a saída pelo QR (4.3 CA4). */
function BluetoothState({ session }: { session: ConnectSession }) {
  const { view, actions } = session;
  const useQr = { label: COPY.useQr, onPress: actions.useQr };
  switch (view.kind) {
    case 'btExplain':
      return (
        <EmptyState
          icon="bluetooth"
          title={COPY.btExplainTitle}
          description={COPY.btExplainText}
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
    case 'cannotAdvertise':
      return (
        <EmptyState
          icon="bluetooth-off"
          title={COPY.cannotAdvertiseTitle}
          description={COPY.cannotAdvertiseText}
          primaryAction={useQr}
          secondaryAction={{ label: COPY.searchAnyway, onPress: actions.searchAnyway }}
          testID="bt-sem-anuncio"
        />
      );
    case 'btUnavailable':
      return (
        <EmptyState
          icon="bluetooth-off"
          title={COPY.btUnavailableTitle}
          description={COPY.btUnavailableText}
          primaryAction={useQr}
          testID="bt-indisponivel"
        />
      );
    case 'start':
    case 'searching':
    case 'waiting':
    case 'notConfirmed':
    case 'connected':
      return null;
  }
}

/** Estados que param a tela (ux.md §5.2): "Tentar de novo" volta ao Inicial. */
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
  const { view, halt, nearby } = session;
  if (halt !== null) return <Halted reason={halt} session={session} />;
  switch (view.kind) {
    case 'start':
      return session.mode === 'qr' ? (
        <QrStart session={session} />
      ) : (
        <BluetoothStart session={session} />
      );
    case 'searching': {
      if (nearby.rows.length > 0) return <NearbyList session={session} />;
      const quietSince = Math.max(view.startedAt, nearby.lastVisibleAt);
      const nobody = nearby.at - quietSince >= connectTiming.nobodyAfterMs;
      return <Searching session={session} nobody={nobody} />;
    }
    case 'waiting':
      return <Waiting session={session} />;
    case 'notConfirmed':
      return <NotConfirmed session={session} />;
    case 'connected':
      return <Connected session={session} />;
    case 'btExplain':
    case 'btDenied':
    case 'btOff':
    case 'btUnavailable':
    case 'cannotAdvertise':
      return <BluetoothState session={session} />;
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
  const { incoming, scanner, actions } = session;
  const head = incoming.head;

  return (
    <>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Body session={session} />
      </ScrollView>
      {head !== null && scanner === null ? (
        <IncomingRequestSheet
          request={head.request}
          secondsLeft={incoming.secondsLeft}
          error={incoming.error}
          busy={incoming.busy}
          acceptByQr={head.request.method === 'qr' && !incoming.simulated}
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
    </>
  );
}

/**
 * Aba Conectar (p10–p14, ux.md §5.2). A sessão só existe com a aba em foco: ao sair da aba, tudo
 * para (anúncio, varredura, polling e token) e a volta começa no Inicial. Em background, tudo
 * pausa (o nativo também para o anúncio e a varredura) e recomeça ao voltar, no mesmo estado
 * (4.3 CA3): no Android, até o pedido de permissão manda o app para o background.
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
  centered: { alignItems: 'center', gap: theme.space[12] },
  stateBlock: { alignItems: 'center', gap: theme.space[8] },
  stateText: { maxWidth: 320 },
  listTitle: { paddingHorizontal: theme.layout.screenX, paddingVertical: theme.space[12] },
});
