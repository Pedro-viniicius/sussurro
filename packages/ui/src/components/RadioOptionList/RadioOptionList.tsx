import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Text } from '../Text/Text';

export interface RadioOption<K extends string = string> {
  key: K;
  title: string;
  description?: string;
}

export interface RadioOptionListProps<K extends string = string> {
  /** Legenda sobre a borda (ex.: "Tipo de conta"). */
  legend: string;
  options: readonly RadioOption<K>[];
  /** `null`: nenhuma opção escolhida ainda (ex.: motivo da denúncia). */
  value: K | null;
  onChange: (key: K) => void;
  /** Texto de ajuda abaixo da lista. */
  helper?: string;
  disabled?: boolean;
  testID?: string;
}

const RADIO = 22;
const DOT = 10;

/**
 * Lista de opções com botão de rádio (p05, ux.md §6.14): fieldset com legenda, linhas com título
 * e descrição, hairline entre linhas, raio 12. Acessível como `radiogroup`/`radio`.
 */
export function RadioOptionList<K extends string>({
  legend,
  options,
  value,
  onChange,
  helper,
  disabled = false,
  testID = 'radio-option-list',
}: RadioOptionListProps<K>) {
  return (
    <View testID={testID} style={styles.wrapper}>
      <View accessibilityRole="radiogroup" accessibilityLabel={legend} style={styles.fieldset}>
        <View style={styles.legend} pointerEvents="none">
          <Text variant="caption" color="grey" style={styles.legendText}>
            {legend}
          </Text>
        </View>
        {options.map((option, index) => {
          const selected = option.key === value;
          return (
            <Pressable
              key={option.key}
              testID={`${testID}-${option.key}`}
              accessibilityRole="radio"
              accessibilityLabel={option.title}
              {...(option.description === undefined
                ? {}
                : { accessibilityHint: option.description })}
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              onPress={() => {
                onChange(option.key);
              }}
              style={({ pressed }) => [
                styles.row,
                index > 0 && styles.divider,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.texts}>
                <Text variant="bodyStrong">{option.title}</Text>
                {option.description === undefined ? null : (
                  <Text variant="bodySm" color="grey">
                    {option.description}
                  </Text>
                )}
              </View>
              <View
                testID={`${testID}-${option.key}-indicator`}
                style={[styles.radio, selected ? styles.radioOn : styles.radioOff]}
              >
                {selected ? <View style={styles.dot} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {helper === undefined ? null : (
        <Text variant="caption" color="grey" testID={`${testID}-helper`}>
          {helper}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: theme.space[6], alignSelf: 'stretch' },
  fieldset: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.white,
    marginTop: theme.space[8],
  },
  legend: {
    position: 'absolute',
    top: -10,
    left: theme.space[12],
    paddingHorizontal: theme.space[4],
    backgroundColor: theme.colors.white,
    zIndex: 1,
  },
  legendText: { fontFamily: theme.fonts.semibold },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[12],
    paddingHorizontal: theme.space[16],
    paddingVertical: theme.space[12],
    minHeight: theme.layout.rowMinHeight,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border },
  pressed: { opacity: theme.opacity.pressed },
  texts: { flex: 1, gap: 2 },
  radio: {
    width: RADIO,
    height: RADIO,
    borderRadius: RADIO / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderWidth: 2, borderColor: theme.colors.blue },
  radioOff: { borderWidth: 1.5, borderColor: theme.colors.border },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: theme.colors.blue },
});
