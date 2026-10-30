import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Text } from '../Text/Text';

export interface SegmentedOption<K extends string = string> {
  key: K;
  label: string;
}

export interface SegmentedControlProps<K extends string = string> {
  options: readonly SegmentedOption<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Nome do grupo para o leitor de tela (ex.: "Como conectar"). */
  accessibilityLabel: string;
  testID?: string;
}

/** Botões e abas de texto não passam de 1,5× na escala de fonte (ux.md §7.4). */
const MAX_FONT_SCALE = 1.5;

/**
 * Seletor de dois ou mais segmentos (tela Conectar, "Bluetooth / QR code", D3; ux.md §6.14):
 * fundo greySoft com raio 10 e padding 3; o segmento ativo é branco com sombra. Para o leitor de
 * tela é um grupo de opções (`radiogroup`/`radio`).
 */
export function SegmentedControl<K extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  testID = 'segmented-control',
}: SegmentedControlProps<K>) {
  return (
    <View
      testID={testID}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={styles.container}
    >
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <Pressable
            key={option.key}
            testID={`${testID}-${option.key}`}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: selected, selected }}
            onPress={() => {
              if (!selected) onChange(option.key);
            }}
            style={[styles.segment, selected && styles.selected]}
          >
            <Text
              variant="bodyStrong"
              color={selected ? 'black' : 'greyStrong'}
              align="center"
              maxFontSizeMultiplier={MAX_FONT_SCALE}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 40,
    flexDirection: 'row',
    padding: 3,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.greySoft,
  },
  segment: {
    flex: 1,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space[8],
    borderRadius: theme.radius.md - 2,
  },
  selected: { backgroundColor: theme.colors.white, boxShadow: theme.shadow.sm },
});
