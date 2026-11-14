import { proximityQrPayload } from '@sussurro/shared';
import {
  PairAvatars,
  ProfileHeader,
  QRCodeCard,
  SegmentedControl,
  Text,
  theme,
  TouchHint,
  UiPreferencesProvider,
} from '@sussurro/ui';
import { type ReactNode, useState } from 'react';
import { StyleSheet, View } from 'react-native';

const noop = () => undefined;

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.block}>
      <Text variant="titleSm" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Caption({ children }: { children: string }) {
  return (
    <Text variant="caption" color="grey">
      {children}
    </Text>
  );
}

const HELENA = { handle: 'helena', name: 'Helena Souza' };
const CAIO = { handle: 'caio.r', name: 'Caio Ribeiro' };

function SegmentedBlock() {
  const [mode, setMode] = useState<'show' | 'read'>('show');
  return (
    <Block title="SegmentedControl">
      <Caption>Conectar (ADR 0013): Mostrar meu código / Ler código</Caption>
      <SegmentedControl
        options={[
          { key: 'show', label: 'Mostrar meu código' },
          { key: 'read', label: 'Ler código' },
        ]}
        value={mode}
        onChange={setMode}
        accessibilityLabel="Como conectar"
        testID="catalog-segmented"
      />
    </Block>
  );
}

/** Componentes da Fase 4 (tela Conectar, ux.md §6.14). */
export function Phase4Components() {
  return (
    <>
      <SegmentedBlock />
      <Block title="TouchHint">
        <Caption>Pronto: demonstração de 2 ciclos que para (ux.md §11.7)</Caption>
        <TouchHint pose="demo" testID="catalog-touch-demo" />
        <Caption>Aproximando: pose "quase"</Caption>
        <TouchHint pose="approaching" testID="catalog-touch-approaching" />
        <Caption>Confirmando: pose "encostados"</Caption>
        <TouchHint pose="touching" testID="catalog-touch-touching" />
        <Caption>
          Reduzir movimento: parada em "afastados", com as setas (compacta, 200 × 180)
        </Caption>
        <UiPreferencesProvider reduceMotion>
          <TouchHint pose="demo" compact testID="catalog-touch-reduced" />
        </UiPreferencesProvider>
      </Block>
      <Block title="PairAvatars">
        <Caption>Aguardando (p13), não confirmado e conectados (p14)</Caption>
        <PairAvatars left={HELENA} right={CAIO} state="waiting" testID="catalog-pair-waiting" />
        <PairAvatars left={HELENA} right={CAIO} state="notConfirmed" testID="catalog-pair-no" />
        <PairAvatars left={HELENA} right={CAIO} state="connected" testID="catalog-pair-yes" />
      </Block>
      <Block title="QRCodeCard">
        <Caption>Meu código (sussurro://c/token, o mesmo do NFC), correção de erro M</Caption>
        <QRCodeCard
          value={proximityQrPayload('AbCdEfGhIjKlMn-_')}
          handle={HELENA.handle}
          name={HELENA.name}
          testID="catalog-qr"
        />
      </Block>
      <Block title="ProfileHeader (conexão)">
        <Caption>
          Perfil de uma conexão (ux.md §4.9): (Conectados ✓) abre "Desfazer conexão"
        </Caption>
        <ProfileHeader
          mode="other"
          handle={CAIO.handle}
          name={CAIO.name}
          bio="Fotografia de rua e café coado."
          counts={{ accountType: 'personal', posts: 12, connections: 48, creators: 9 }}
          onBack={noop}
          onMore={noop}
          connection={{ onPress: noop }}
          testID="catalog-profile-connection"
        />
      </Block>
    </>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[12] },
});
