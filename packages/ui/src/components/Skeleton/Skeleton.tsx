import { useEffect, useState } from 'react';
import { Animated, type DimensionValue, StyleSheet, useWindowDimensions, View } from 'react-native';

import { useReducedMotion } from '../../preferences';
import { theme } from '../../theme';

export interface SkeletonProps {
  width: DimensionValue;
  height: number;
  radius?: number;
  testID?: string;
}

/** Bloco de carregamento: `skeleton` com pulso de opacidade 1 → 0,6 (parado com "Reduzir movimento"). */
export function Skeleton({ width, height, radius = theme.radius.sm, testID }: SkeletonProps) {
  const reduceMotion = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.6, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity, reduceMotion]);

  return (
    <Animated.View
      testID={testID}
      style={[
        styles.block,
        { width, height, borderRadius: radius, opacity: reduceMotion ? 1 : opacity },
      ]}
    />
  );
}

/** Esqueleto de um item do feed (ux.md §5.1: 3 skeletons do item). */
export function PostSkeleton({ kind, testID }: { kind: 'photo' | 'text'; testID?: string }) {
  const { width } = useWindowDimensions();
  if (kind === 'text') {
    return (
      <View
        testID={testID}
        style={styles.textRow}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Skeleton width={36} height={36} radius={18} />
        <View style={styles.lines}>
          <Skeleton width="40%" height={14} />
          <Skeleton width="100%" height={14} />
          <Skeleton width="80%" height={14} />
        </View>
      </View>
    );
  }
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.header}>
        <Skeleton width={32} height={32} radius={16} />
        <Skeleton width={120} height={14} />
      </View>
      <Skeleton width={width} height={Math.round((width * 5) / 4)} radius={0} />
      <View style={[styles.lines, styles.padded]}>
        <Skeleton width={90} height={14} />
        <Skeleton width="70%" height={14} />
      </View>
    </View>
  );
}

/** Esqueleto de um comentário. */
export function CommentSkeleton() {
  return (
    <View
      style={styles.textRow}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Skeleton width={32} height={32} radius={16} />
      <View style={styles.lines}>
        <Skeleton width="30%" height={12} />
        <Skeleton width="85%" height={12} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: theme.colors.skeleton },
  header: {
    minHeight: theme.layout.postHeaderHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: theme.layout.screenX,
  },
  textRow: {
    flexDirection: 'row',
    gap: theme.space[12],
    paddingHorizontal: theme.layout.screenX,
    paddingVertical: 14,
  },
  lines: { flex: 1, gap: theme.space[8], paddingVertical: theme.space[4] },
  padded: { paddingHorizontal: theme.layout.screenX, paddingVertical: theme.space[12] },
});
