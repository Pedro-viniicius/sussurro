import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Text } from '../Text/Text';

export type CreateMode = 'photo' | 'text' | 'reel';

const LABELS: Record<CreateMode, string> = { photo: 'FOTO', text: 'TEXTO', reel: 'REEL' };
const SPOKEN: Record<CreateMode, string> = { photo: 'Foto', text: 'Texto', reel: 'Reel' };
const ORDER: readonly CreateMode[] = ['photo', 'text', 'reel'];

export interface ModePillProps {
  value: CreateMode;
  onChange: (mode: CreateMode) => void;
  /** Modos ainda indisponíveis (REEL até a Fase 5). */
  disabled?: readonly CreateMode[];
  testID?: string;
}

/**
 * Pílula FOTO/TEXTO/REEL do Criar (p18, ux.md §6.14): fundo `ink`, raio total, segmento ativo
 * branco com texto preto, inativos em `inkMuted`.
 */
export function ModePill({ value, onChange, disabled = [], testID = 'mode-pill' }: ModePillProps) {
  return (
    <View testID={testID} accessibilityRole="tablist" style={styles.pill}>
      {ORDER.map((mode) => {
        const selected = mode === value;
        const off = disabled.includes(mode);
        return (
          <Pressable
            key={mode}
            testID={`${testID}-${mode}`}
            accessibilityRole="tab"
            accessibilityLabel={SPOKEN[mode]}
            {...(off ? { accessibilityHint: 'Disponível em breve' } : {})}
            accessibilityState={{ selected, disabled: off }}
            disabled={off}
            onPress={() => {
              if (!selected) onChange(mode);
            }}
            style={[styles.segment, selected && styles.selected, off && styles.off]}
          >
            <Text
              variant="buttonSm"
              color={selected ? 'black' : 'inkMuted'}
              style={styles.label}
              maxFontSizeMultiplier={1.5}
            >
              {LABELS[mode]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignSelf: 'center',
    backgroundColor: theme.colors.ink,
    borderRadius: theme.radius.full,
    padding: theme.space[4],
    boxShadow: theme.shadow.md,
  },
  segment: {
    minHeight: 36,
    minWidth: 76,
    paddingHorizontal: theme.space[16],
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selected: { backgroundColor: theme.colors.white },
  off: { opacity: 0.5 },
  label: { letterSpacing: 0.5 },
});
