import { feedWindowLabel, formatReelDuration } from '@sussurro/shared';
import {
  CaughtUp,
  ReelTile,
  spokenDuration,
  Text,
  theme,
  UploadBanner,
  useToast,
} from '@sussurro/ui';
import { type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { catalogImages } from './images';

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

const [azul, verde, areia] = catalogImages;

/** Reels do feed de p08 (0:42, 0:18, 0:55 e 0:12). */
const P08_REELS = [
  { key: 'reel-azul', uri: azul.uri, durationS: 42, handle: 'marinac' },
  { key: 'reel-verde', uri: verde.uri, durationS: 18, handle: 'juprado' },
  { key: 'reel-areia', uri: areia.uri, durationS: 55, handle: 'cozinhadabia' },
  { key: 'reel-azul-2', uri: azul.uri, durationS: 12, handle: 'marinac' },
] as const;

function useTileWidth(): number {
  const { width } = useWindowDimensions();
  // O catálogo tem 16 de margem de cada lado.
  return (width - theme.layout.screenX * 2 - theme.layout.gridGap * 2) / 3;
}

/** Componentes da Fase 5 (reels, ux.md §6.14): ReelTile nos três estados e a faixa do reel. */
export function Phase5Components() {
  const toast = useToast();
  const tileWidth = useTileWidth();
  return (
    <>
      <Block title="ReelTile">
        <Caption>Pronto (duração sobre o mediaScrim), processando e falhou (só o autor vê)</Caption>
        <View style={[styles.row, { gap: theme.layout.gridGap }]}>
          <ReelTile
            thumb={{ key: 'catalogo-reel', uri: areia.uri }}
            duration={formatReelDuration(55)}
            width={tileWidth}
            onPress={noop}
            accessibilityLabel={`Reel de @cozinhadabia, ${spokenDuration(55)}`}
            testID="catalog-reel-ready"
          />
          <ReelTile
            thumb={{ key: 'catalogo-reel-processando', uri: null }}
            duration={null}
            width={tileWidth}
            status="processing"
            accessibilityLabel="Reel"
            testID="catalog-reel-processing"
          />
          <ReelTile
            thumb={{ key: 'catalogo-reel-falhou', uri: null }}
            duration={null}
            width={tileWidth}
            status="failed"
            onPress={() => {
              toast.show({ message: 'No app: "Tentar de novo" e "Excluir".' });
            }}
            accessibilityLabel="Reel"
            testID="catalog-reel-failed"
          />
        </View>
      </Block>
      <Block title="UploadBanner (reel)">
        <View style={styles.bleed}>
          <UploadBanner kind="reel" status="uploading" progress={0.4} thumbUri={azul.uri} />
          <UploadBanner kind="reel" status="processing" thumbUri={verde.uri} />
          <UploadBanner kind="reel" status="failed" onRetry={noop} onDiscard={noop} />
          <UploadBanner kind="reel" status="unavailable" onRetry={noop} onDiscard={noop} />
        </View>
      </Block>
    </>
  );
}

/** Feed Reels montado com fixtures, para comparar com p08. */
export function ReelsFeedScreen() {
  const tileWidth = useTileWidth();
  return (
    <Block title="Feed Reels (p08)">
      <View
        style={[styles.row, styles.wrap, { gap: theme.layout.gridGap }]}
        testID="catalog-feed-reels"
      >
        {P08_REELS.map((reel) => (
          <ReelTile
            key={reel.key}
            thumb={{ key: reel.key, uri: reel.uri }}
            duration={formatReelDuration(reel.durationS)}
            width={tileWidth}
            onPress={noop}
            accessibilityLabel={`Reel de @${reel.handle}, ${spokenDuration(reel.durationS)}`}
          />
        ))}
      </View>
      <CaughtUp kind="reel" windowLabel={feedWindowLabel(72)} />
    </Block>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[12] },
  row: { flexDirection: 'row' },
  wrap: { flexWrap: 'wrap' },
  bleed: { marginHorizontal: -theme.layout.screenX },
});
