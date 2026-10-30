import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { PostImage, type PostImageSource } from '../Post/PostImage';
import { Text } from '../Text/Text';

export type PhotoTileStatus = 'ready' | 'processing' | 'failed';

export interface PhotoTileProps {
  /** Capa (primeira foto, miniatura de 360 px). */
  image: PostImageSource;
  /** Largura do quadrado; a altura sai do 3:4. */
  width: number;
  /** Ícone `copy` no canto quando o post tem 2 ou mais fotos (p16, p17). */
  multiple?: boolean;
  /** `processing`/`failed` só aparecem para o dono (MID-09, 2.6 CA3). */
  status?: PhotoTileStatus;
  onPress?: () => void;
  accessibilityLabel: string;
  testID?: string;
}

/** Quadrado da grade de fotos do perfil: 3:4 (ux.md §6.6 e §6.14). */
export function PhotoTile({
  image,
  width,
  multiple = false,
  status = 'ready',
  onPress,
  accessibilityLabel,
  testID = `photo-tile-${image.key}`,
}: PhotoTileProps) {
  const height = Math.round((width * 4) / 3);
  const label =
    status === 'processing'
      ? `${accessibilityLabel}, processando`
      : status === 'failed'
        ? `${accessibilityLabel}, não foi possível publicar`
        : accessibilityLabel;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={onPress === undefined}
      onPress={onPress}
      style={({ pressed }) => [{ width, height }, pressed && styles.pressed]}
    >
      {status === 'ready' ? (
        <PostImage source={image} width={width} height={height} compact />
      ) : (
        <View style={[styles.state, { width, height }]}>
          {status === 'processing' ? (
            <>
              <ActivityIndicator size="small" color={theme.colors.greyStrong} />
              <Text variant="micro" color="greyStrong">
                Processando
              </Text>
            </>
          ) : (
            <>
              <Icon name="circle-alert" size={20} color="danger" />
              <Text variant="micro" color="danger">
                Falhou
              </Text>
            </>
          )}
        </View>
      )}
      {multiple && status === 'ready' ? (
        <View style={styles.copy} pointerEvents="none">
          <Icon name="copy" size={16} color="white" />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: theme.opacity.pressed },
  state: {
    backgroundColor: theme.colors.greySoft,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[4],
  },
  copy: {
    position: 'absolute',
    top: theme.space[8],
    right: theme.space[8],
    boxShadow: theme.shadow.icon,
  },
});
