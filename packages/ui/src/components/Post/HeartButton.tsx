import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet } from 'react-native';

import { useReducedMotion } from '../../preferences';
import { type ColorToken, theme } from '../../theme';
import { Icon } from '../Icon/Icon';

export interface HeartButtonProps {
  liked: boolean;
  onPress: () => void;
  /** 24 no post de foto; 20 na thread de textos (ux.md §6.13). */
  size?: number;
  /** Cor do coração sem curtida: preto no post; branco no ReelViewer (fundo preto). */
  color?: ColorToken;
  testID?: string;
}

/**
 * Curtir: coração com contorno; curtido = preenchido em `blue` com "pop" (escala 1 → 1,2 → 1,
 * `motion.heart`), sem animação com "Reduzir movimento" (ux.md §6.10).
 */
export function HeartButton({
  liked,
  onPress,
  size = theme.size.icon.md,
  color = 'black',
  testID = 'heart',
}: HeartButtonProps) {
  const reduceMotion = useReducedMotion();
  const [scale] = useState(() => new Animated.Value(1));
  const previous = useRef(liked);

  useEffect(() => {
    if (liked && !previous.current && !reduceMotion) {
      const half = theme.motion.heart / 2;
      const easing = Easing.bezier(...theme.motion.easing);
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.2, duration: half, easing, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: half, easing, useNativeDriver: true }),
      ]).start();
    }
    previous.current = liked;
  }, [liked, reduceMotion, scale]);

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={liked ? 'Curtido' : 'Curtir'}
      accessibilityState={{ selected: liked }}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <Icon
          name="heart"
          size={size}
          color={liked ? 'blue' : color}
          filled={liked}
          testID={liked ? `${testID}-filled` : `${testID}-outline`}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: theme.layout.hitMin, justifyContent: 'center' },
  pressed: { opacity: theme.opacity.pressed },
});
