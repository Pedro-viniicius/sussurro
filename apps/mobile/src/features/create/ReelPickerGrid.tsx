import { formatReelDuration } from '@sussurro/shared';
import { Icon, MediaScrim, spokenDuration, Text, theme } from '@sussurro/ui';
import { Image } from 'expo-image';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { REEL_PROBLEM_LABEL, type ReelCandidate } from './reel-selection';

export interface ReelPickerGridProps {
  candidates: readonly ReelCandidate[];
  selected: string | null;
  onToggle: (key: string) => void;
  /** Primeiro quadrado: abre o seletor de vídeos do sistema. */
  onAdd: () => void;
  /** O vídeo escolhido ainda está sendo lido (capa e duração). */
  adding: boolean;
  width: number;
}

const COLUMNS = 4;
const SELECTOR = 22;

/**
 * Grade do Criar no modo REEL (ux.md §4.5): 4 colunas 1:1, só vídeos, seleção única, a duração
 * sobre a capa. Vídeo fora dos limites (D10) fica esmaecido com "Até 90 s" (ou "Até 200 MB") e não
 * pode ser marcado. Os vídeos vêm do seletor do sistema, um por vez, sem acesso à galeria.
 */
export function ReelPickerGrid({
  candidates,
  selected,
  onToggle,
  onAdd,
  adding,
  width,
}: ReelPickerGridProps) {
  const gap = theme.layout.gridGap;
  const size = Math.floor((width - gap * (COLUMNS - 1)) / COLUMNS);

  return (
    <View testID="reel-picker" style={[styles.grid, { gap }]}>
      <Pressable
        testID="reel-picker-add"
        accessibilityRole="button"
        accessibilityLabel="Escolher vídeo do aparelho"
        accessibilityState={{ busy: adding, disabled: adding }}
        disabled={adding}
        onPress={onAdd}
        style={({ pressed }) => [
          styles.add,
          { width: size, height: size },
          pressed && styles.pressed,
        ]}
      >
        {adding ? (
          <ActivityIndicator color={theme.colors.greyStrong} />
        ) : (
          <Icon name="video" size={theme.size.icon.lg} color="greyStrong" />
        )}
        <Text variant="caption" color="greyStrong">
          Escolher
        </Text>
      </Pressable>
      {candidates.map(({ video, poster, problem }, index) => {
        const isSelected = selected === video.key;
        const duration = video.durationS === null ? null : formatReelDuration(video.durationS);
        const spoken = video.durationS === null ? null : spokenDuration(video.durationS);
        const label = [
          `Vídeo ${String(index + 1)}`,
          spoken,
          problem === null ? null : REEL_PROBLEM_LABEL[problem].toLowerCase(),
          isSelected ? 'selecionado' : null,
        ]
          .filter((part): part is string => part !== null)
          .join(', ');
        return (
          <Pressable
            key={video.key}
            testID={`reel-picker-item-${String(index)}`}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: isSelected }}
            onPress={() => {
              onToggle(video.key);
            }}
            style={{ width: size, height: size }}
          >
            <View style={[StyleSheet.absoluteFill, problem !== null && styles.dimmed]}>
              <Image
                source={{ uri: poster.uri }}
                contentFit="cover"
                accessible={false}
                style={StyleSheet.absoluteFill}
              />
              <MediaScrim coverage={0.5} testID={`reel-picker-item-${String(index)}-scrim`} />
              {duration === null ? null : (
                <View style={styles.duration} pointerEvents="none">
                  <Icon name="play" size={12} color="white" filled />
                  <Text variant="micro" color="white" tabularNums>
                    {duration}
                  </Text>
                </View>
              )}
            </View>
            {problem === null ? (
              <View style={[styles.selector, isSelected ? styles.selectorOn : styles.selectorOff]}>
                {isSelected ? <Icon name="check" size={14} color="white" /> : null}
              </View>
            ) : (
              <View style={styles.limit} pointerEvents="none">
                <View style={styles.chip}>
                  <Text
                    variant="micro"
                    color="white"
                    align="center"
                    testID={`reel-picker-item-${String(index)}-limite`}
                  >
                    {REEL_PROBLEM_LABEL[problem]}
                  </Text>
                </View>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  add: {
    backgroundColor: theme.colors.greySoft,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[4],
  },
  pressed: { opacity: theme.opacity.pressed },
  dimmed: { opacity: theme.opacity.disabled },
  duration: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  selector: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: SELECTOR,
    height: SELECTOR,
    borderRadius: SELECTOR / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectorOff: {
    borderWidth: 1.5,
    borderColor: theme.colors.white,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  selectorOn: { backgroundColor: theme.colors.blue },
  limit: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: {
    backgroundColor: theme.colors.mediaChip,
    borderRadius: theme.radius.full,
    paddingVertical: theme.space[2],
    paddingHorizontal: theme.space[8],
  },
});
