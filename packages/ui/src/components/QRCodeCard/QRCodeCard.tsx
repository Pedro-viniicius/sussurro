import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { useReducedMotion } from '../../preferences';
import { theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Text } from '../Text/Text';

/** Margem branca em módulos dentro do desenho (o card completa a zona de silêncio). */
const QUIET_MODULES = 2;
/** Troca do QR renovado: fade de 150 ms, sem quadro vazio (ux.md §4.10). */
const SWAP_MS = 150;

export interface QrMatrix {
  /** Caminho SVG dos módulos escuros, em unidades de módulo. */
  path: string;
  /** Módulos por lado (sem a margem). */
  modules: number;
}

/**
 * Matriz do QR (correção de erro M, ux.md §6.14) como um caminho SVG: cada sequência de módulos
 * escuros numa linha vira um retângulo. Só JS (`qrcode-generator`, sem dependências).
 */
export function qrMatrix(value: string): QrMatrix {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const modules = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < modules; row += 1) {
    let col = 0;
    while (col < modules) {
      if (!qr.isDark(row, col)) {
        col += 1;
        continue;
      }
      let run = 1;
      while (col + run < modules && qr.isDark(row, col + run)) run += 1;
      path += `M${col + QUIET_MODULES} ${row + QUIET_MODULES}h${run}v1h-${run}z`;
      col += run;
    }
  }
  return { path, modules };
}

export interface QRCodeProps {
  value: string;
  size?: number;
  testID?: string;
}

/** O QR em preto sobre branco. */
export function QRCode({ value, size = 240, testID = 'qr-code' }: QRCodeProps) {
  const matrix = useMemo(() => qrMatrix(value), [value]);
  const box = matrix.modules + 2 * QUIET_MODULES;
  return (
    <Svg testID={testID} width={size} height={size} viewBox={`0 0 ${box} ${box}`}>
      <Rect width={box} height={box} fill={theme.colors.white} />
      <Path d={matrix.path} fill={theme.colors.black} />
    </Svg>
  );
}

export interface QRCodeCardProps {
  /** Conteúdo do QR (`sussurro://c/{token}`); `null` enquanto o primeiro token não chega. */
  value: string | null;
  handle: string;
  name?: string;
  avatarUri?: string | null;
  avatarSeed?: string;
  size?: number;
  /** Descrição para o leitor de tela (o QR em si não tem texto). */
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * Card do "meu código" (ux.md §4.10 e §6.14): QR 240 num card branco com borda e raio 16, e o
 * Avatar 32 com o @ abaixo. A cada token novo, o QR anterior some num fade de 150 ms por cima do
 * novo: a tela nunca fica sem código (4.2 CA3, 4.7 CA1).
 */
export function QRCodeCard({
  value,
  handle,
  name,
  avatarUri,
  avatarSeed,
  size = 240,
  accessibilityLabel = `Seu código para conectar, @${handle}`,
  testID = 'qr-card',
}: QRCodeCardProps) {
  const reduceMotion = useReducedMotion();
  const [layers, setLayers] = useState<{ current: string | null; previous: string | null }>({
    current: value,
    previous: null,
  });
  const [fade] = useState(() => new Animated.Value(0));

  // Token novo: o anterior vira a camada de cima e some (padrão "ajustar estado no render").
  if (layers.current !== value) {
    setLayers({ current: value, previous: value === null ? null : layers.current });
  }

  useEffect(() => {
    if (layers.previous === null) return undefined;
    fade.setValue(1);
    const animation = Animated.timing(fade, {
      toValue: 0,
      duration: reduceMotion ? 0 : SWAP_MS,
      useNativeDriver: true,
    });
    animation.start(() => {
      setLayers((state) => ({ ...state, previous: null }));
    });
    return () => {
      animation.stop();
    };
  }, [fade, layers.previous, reduceMotion]);

  return (
    <View style={styles.wrapper} testID={testID}>
      <View
        style={styles.card}
        accessible
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
      >
        <View style={{ width: size, height: size }}>
          {layers.current === null ? (
            <View style={styles.loading} testID={`${testID}-carregando`}>
              <ActivityIndicator color={theme.colors.grey} />
            </View>
          ) : (
            <QRCode value={layers.current} size={size} testID={`${testID}-qr`} />
          )}
          {layers.previous === null ? null : (
            <Animated.View
              style={[StyleSheet.absoluteFill, { opacity: fade }]}
              pointerEvents="none"
            >
              <QRCode value={layers.previous} size={size} testID={`${testID}-qr-anterior`} />
            </Animated.View>
          )}
        </View>
      </View>
      <View style={styles.owner}>
        <Avatar
          size={theme.size.avatar.sm}
          handle={handle}
          {...(name === undefined ? {} : { name })}
          {...(avatarSeed === undefined ? {} : { seed: avatarSeed })}
          {...(avatarUri === undefined ? {} : { uri: avatarUri })}
          decorative
        />
        <Text variant="bodyStrong">{handle}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignItems: 'center', gap: theme.space[12] },
  card: {
    padding: theme.space[12],
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.white,
  },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  owner: { flexDirection: 'row', alignItems: 'center', gap: theme.space[8] },
});
