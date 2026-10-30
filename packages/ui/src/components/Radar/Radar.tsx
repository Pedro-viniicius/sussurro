import { type ReactNode, useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';

import { useReducedMotion } from '../../preferences';
import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { Text } from '../Text/Text';

const BUTTON_SIZE = 160;
const INNER_RING = 196;
const OUTER_RING = 252;
const PULSE_RINGS = 3;
/** Defasagem entre os anéis (ux.md §6.10: 3 anéis, 800 ms). */
const PULSE_STAGGER = theme.motion.radarCycle / PULSE_RINGS;

/** Um anel que cresce de 0,6 a 1,4 e some (opacidade 0,6 → 0), em ciclo de 2,4 s. */
function PulseRing({ index }: { index: number }) {
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const animation = Animated.sequence([
      Animated.delay(index * PULSE_STAGGER),
      Animated.loop(
        Animated.timing(progress, {
          toValue: 1,
          duration: theme.motion.radarCycle,
          easing: Easing.bezier(...theme.motion.easing),
          useNativeDriver: true,
        }),
      ),
    ]);
    animation.start();
    return () => {
      animation.stop();
    };
  }, [index, progress]);

  return (
    <Animated.View
      style={[
        styles.pulse,
        {
          opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
          transform: [
            { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.4] }) },
          ],
        },
      ]}
    />
  );
}

function Rings({ animated }: { animated: boolean }) {
  return (
    <>
      <View style={[styles.ring, styles.outer]} />
      <View style={[styles.ring, styles.inner]} />
      {animated
        ? Array.from({ length: PULSE_RINGS }, (_, index) => <PulseRing key={index} index={index} />)
        : null}
    </>
  );
}

export interface RadarProps {
  /**
   * `idle` (p10): botão central azul "Procurar por perto". `searching` (p11): o centro é o avatar
   * e os anéis pulsam (estáticos com "Reduzir movimento", ux.md §6.10).
   */
  variant: 'idle' | 'searching';
  /** Só no `idle`. */
  onPress?: () => void;
  label?: string;
  /** Só no `searching`: o avatar no centro (Avatar 64). */
  center?: ReactNode;
  disabled?: boolean;
  testID?: string;
}

/** Radar da tela Conectar (ux.md §6.14): anéis 196/252 em blueMist/blueLight. */
export function Radar({
  variant,
  onPress,
  label = 'Procurar por perto',
  center,
  disabled = false,
  testID = 'radar',
}: RadarProps) {
  const reduceMotion = useReducedMotion();
  const animated = variant === 'searching' && !reduceMotion;

  return (
    <View testID={testID} style={styles.container}>
      <View
        testID={`${testID}-${animated ? 'animado' : 'estatico'}`}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={styles.center}>
          <Rings animated={animated} />
        </View>
      </View>
      {variant === 'idle' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onPress}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Icon name="radio" size={theme.size.icon.lg} color="white" />
          <Text variant="button" color="white" align="center" style={styles.buttonLabel}>
            {label}
          </Text>
        </Pressable>
      ) : (
        <View style={styles.avatarRings}>{center}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: OUTER_RING,
    height: OUTER_RING,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', borderRadius: OUTER_RING / 2, borderWidth: 2 },
  outer: {
    width: OUTER_RING,
    height: OUTER_RING,
    borderColor: theme.colors.blueLight,
  },
  inner: {
    width: INNER_RING,
    height: INNER_RING,
    borderRadius: INNER_RING / 2,
    borderColor: theme.colors.blueMist,
  },
  pulse: {
    position: 'absolute',
    width: INNER_RING,
    height: INNER_RING,
    borderRadius: INNER_RING / 2,
    borderWidth: 2,
    borderColor: theme.colors.blueMid,
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: theme.colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[8],
    paddingHorizontal: theme.space[12],
  },
  buttonLabel: { maxWidth: BUTTON_SIZE - 2 * theme.space[12] },
  pressed: { backgroundColor: theme.colors.bluePressed },
  avatarRings: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 2,
    borderColor: theme.colors.blueMid,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
