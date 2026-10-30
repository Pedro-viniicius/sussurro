import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { useReducedMotion } from '../../preferences';
import { theme } from '../../theme';

export interface ProgressBarProps {
  /** 0 a 1. Sem valor, a barra é indeterminada (parada com "Reduzir movimento"). */
  progress?: number;
  accessibilityLabel?: string;
  testID?: string;
}

const SEGMENT = 0.3;

/** Barra de 2 pt: trilho `greySoft`, preenchimento `blue` (ux.md §6.14). */
export function ProgressBar({
  progress,
  accessibilityLabel,
  testID = 'progress',
}: ProgressBarProps) {
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [offset] = useState(() => new Animated.Value(0));
  const indeterminate = progress === undefined;

  useEffect(() => {
    if (!indeterminate || reduceMotion || width === 0) {
      return undefined;
    }
    const loop = Animated.loop(
      Animated.timing(offset, {
        toValue: 1,
        duration: 1200,
        easing: (value) => value,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [indeterminate, reduceMotion, width, offset]);

  const value = Math.max(0, Math.min(1, progress ?? 0));
  const translateX = offset.interpolate({
    inputRange: [0, 1],
    outputRange: [-width * SEGMENT, width],
  });

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      accessibilityValue={
        indeterminate
          ? { text: 'Em andamento' }
          : { min: 0, max: 100, now: Math.round(value * 100) }
      }
      style={styles.track}
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
      }}
    >
      {indeterminate ? (
        <Animated.View
          style={[
            styles.fill,
            { width: `${SEGMENT * 100}%` },
            reduceMotion ? { left: '35%' } : { transform: [{ translateX }] },
          ]}
        />
      ) : (
        <View style={[styles.fill, { width: `${value * 100}%` }]} testID={`${testID}-fill`} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: theme.size.progressBar,
    backgroundColor: theme.colors.greySoft,
    overflow: 'hidden',
  },
  fill: { position: 'absolute', top: 0, bottom: 0, backgroundColor: theme.colors.blue },
});
