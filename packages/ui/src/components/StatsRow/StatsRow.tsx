import { Pressable, StyleSheet, View } from 'react-native';

import { formatInteger, pluralize } from '../../format/format';
import { theme } from '../../theme';
import { Text } from '../Text/Text';

export interface StatLabel {
  one: string;
  other: string;
}

/** Rótulos no singular e no plural (ux.md §6.13). */
export const STAT_LABELS = {
  posts: { one: 'publicação', other: 'publicações' },
  connections: { one: 'conexão', other: 'conexões' },
  creators: { one: 'criador', other: 'criadores' },
  followers: { one: 'seguidor', other: 'seguidores' },
} as const satisfies Record<string, StatLabel>;

/** Uma casa decimal, truncada (nunca arredonda para cima), com vírgula. Aritmética inteira. */
function oneDecimal(value: number, unit: number): string {
  const tenths = Math.floor((value * 10) / unit);
  const truncated = tenths / 10;
  return Number.isInteger(truncated) ? String(truncated) : truncated.toFixed(1).replace('.', ',');
}

/** pt-BR: até 9.999 com ponto; 10 mil a 999 mil → "12,4 mil"; a partir de 1 milhão → "1,2 mi". */
export function formatStatCount(value: number): string {
  const n = Math.max(0, Math.trunc(value));
  if (n < 10_000) {
    return formatInteger(n);
  }
  if (n < 1_000_000) {
    return `${oneDecimal(n, 1_000)} mil`;
  }
  return `${oneDecimal(n, 1_000_000)} mi`;
}

export function statLabel(value: number, label: StatLabel): string {
  return pluralize(value, label.one, label.other);
}

export interface StatItem {
  value: number;
  label: StatLabel;
  /** Só para o dono (listas privadas, ADR 0004). Seguidores de criador nunca são tocáveis. */
  onPress?: () => void;
}

export interface StatsRowProps {
  items: readonly StatItem[];
  testID?: string;
}

export function StatsRow({ items, testID = 'stats-row' }: StatsRowProps) {
  return (
    <View testID={testID} style={styles.row}>
      {items.map((item, index) => {
        const text = formatStatCount(item.value);
        const label = statLabel(item.value, item.label);
        const content = (
          <>
            <Text variant="stat" align="center" tabularNums>
              {text}
            </Text>
            <Text variant="bodySm" align="center">
              {label}
            </Text>
          </>
        );
        const key = `${label}-${index}`;
        if (item.onPress === undefined) {
          return (
            <View
              key={key}
              testID={`${testID}-${index}`}
              accessible
              accessibilityLabel={`${text} ${label}`}
              style={styles.item}
            >
              {content}
            </View>
          );
        }
        return (
          <Pressable
            key={key}
            testID={`${testID}-${index}`}
            accessibilityRole="button"
            accessibilityLabel={`${text} ${label}`}
            accessibilityHint="Abre a lista, visível só para você"
            onPress={item.onPress}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            {content}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  item: { flex: 1, alignItems: 'center', minHeight: theme.layout.hitMin, justifyContent: 'center' },
  pressed: { opacity: theme.opacity.pressed },
});
