import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { Text } from '../Text/Text';

export type CaughtUpKind = 'photo' | 'text' | 'reel';

const SEEN: Record<CaughtUpKind, string> = {
  photo: 'todas as fotos',
  text: 'todos os textos',
  reel: 'todos os reels',
};

const ARTICLE: Record<string, string> = {
  últimos: 'dos',
  último: 'do',
  últimas: 'das',
  última: 'da',
};

/**
 * "de" + artigo antes do período ("últimos 3 dias" → "dos últimos 3 dias"). O período vem pronto
 * do app (`feedWindowLabel` de packages/shared, FEED-04): a regra das horas e dos dias fica num
 * lugar só, e o design system só monta a frase.
 */
export function caughtUpPeriod(windowLabel: string): string {
  const first = windowLabel.split(' ')[0] ?? '';
  return `${ARTICLE[first] ?? 'de'} ${windowLabel}`;
}

export function caughtUpMessage(kind: CaughtUpKind, windowLabel: string): string {
  return `Você viu ${SEEN[kind]} ${caughtUpPeriod(windowLabel)} de quem você conhece e segue.`;
}

export interface CaughtUpProps {
  kind: CaughtUpKind;
  /** Período da janela já em texto (`feedWindowLabel(windowHours)`): "últimos 3 dias". */
  windowLabel: string;
  testID?: string;
}

/** Fim do feed: "Você está em dia" (círculo de contorno, como no p08 — D-UX20). */
export function CaughtUp({ kind, windowLabel, testID = 'caught-up' }: CaughtUpProps) {
  const message = caughtUpMessage(kind, windowLabel);
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Você está em dia. ${message}`}
      style={styles.container}
    >
      <View style={styles.circle}>
        <Icon name="check" size={theme.size.icon.lg} color="blue" />
      </View>
      <Text variant="titleSm" align="center">
        Você está em dia
      </Text>
      <Text variant="bodySm" color="grey" align="center" style={styles.message}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: theme.space[40],
    paddingHorizontal: theme.layout.screenX,
    gap: theme.space[8],
  },
  circle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    borderColor: theme.colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.space[4],
  },
  message: { maxWidth: 300 },
});
