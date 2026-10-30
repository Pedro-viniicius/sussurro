import { useState } from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';

import { avatarColor, avatarInitials } from './avatar-color';
import { useReducedMotion } from '../../preferences';
import { type AvatarSize, theme } from '../../theme';
import { Text } from '../Text/Text';

export interface AvatarProps {
  size?: AvatarSize;
  handle: string;
  name?: string;
  /** Semente da cor (userId). Sem ela, usa o handle. */
  seed?: string;
  uri?: string | null;
  /** Anel preto da aba Perfil ativa (ux.md §6.8). */
  ring?: boolean;
  /** Modo agregado "+N" (notificação de novos seguidores, p21). */
  count?: number;
  /** Texto do modo agregado quando não é "+N" (ex.: "99+" acima de 99, `followersBadge`). */
  countLabel?: string;
  /** Decorativo quando o @ ou o nome já aparece ao lado (padrão do ux.md §6.13). */
  decorative?: boolean;
  testID?: string;
}

const FADE_MS = 150;

export function Avatar({
  size = 44,
  handle,
  name,
  seed,
  uri,
  ring = false,
  count,
  countLabel,
  decorative = false,
  testID = 'avatar',
}: AvatarProps) {
  const reduceMotion = useReducedMotion();
  // A falha vale só para a URL que falhou: outra URL tenta de novo, sem efeito colateral.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const [opacity] = useState(() => new Animated.Value(0));
  const failed = failedUri !== null && failedUri === uri;

  const aggregate = count !== undefined;
  const background = aggregate ? theme.colors.blueLight : avatarColor(seed ?? handle).color;
  const label = aggregate
    ? `${count} ${count === 1 ? 'nova pessoa' : 'novas pessoas'}`
    : `Foto de perfil de @${handle}`;
  const text = aggregate ? (countLabel ?? `+${count}`) : avatarInitials(name, handle);
  const showPhoto = !aggregate && typeof uri === 'string' && uri !== '' && !failed;

  const circle = (
    <View
      testID={`${testID}-circle`}
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: background },
      ]}
    >
      <Text
        allowFontScaling={false}
        variant="bodyStrong"
        style={{ fontSize: Math.round(size * 0.36), lineHeight: Math.round(size * 0.36) * 1.2 }}
      >
        {text}
      </Text>
      {showPhoto ? (
        <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
          <Image
            testID={`${testID}-photo`}
            source={{ uri }}
            style={{ width: size, height: size, borderRadius: size / 2 }}
            onLoadStart={() => {
              opacity.setValue(0);
            }}
            onLoad={() => {
              Animated.timing(opacity, {
                toValue: 1,
                duration: reduceMotion ? 0 : FADE_MS,
                useNativeDriver: true,
              }).start();
            }}
            onError={() => {
              setFailedUri(uri);
            }}
          />
        </Animated.View>
      ) : null}
    </View>
  );

  const a11y = decorative
    ? {
        accessible: false,
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants' as const,
      }
    : { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: label };

  if (!ring) {
    return (
      <View testID={testID} {...a11y}>
        {circle}
      </View>
    );
  }

  const { gap, stroke } = theme.size.avatarRing;
  const outer = size + 2 * (gap + stroke);
  return (
    <View
      testID={testID}
      {...a11y}
      style={[
        styles.ring,
        { width: outer, height: outer, borderRadius: outer / 2, borderWidth: stroke },
      ]}
    >
      {circle}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  ring: {
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: theme.colors.black,
  },
});
