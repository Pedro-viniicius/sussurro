import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { MediaScrim } from './MediaScrim';
import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { PostImage, type PostImageSource } from '../Post/PostImage';
import { Text } from '../Text/Text';

export type ReelTileStatus = 'ready' | 'processing' | 'failed';

export interface ReelTileProps {
  /** Poster do reel (miniatura). A chave do cache é o id da mídia; `uri` é `null` até ficar pronto. */
  thumb: PostImageSource;
  /** Duração já formatada pelo app (`formatReelDuration`: "0:42"); `null` esconde o rótulo. */
  duration: string | null;
  /** Largura do tile; a altura sai do 9:16. */
  width: number;
  /** `processing`/`failed` só aparecem na grade do autor (MID-09, 5.6). */
  status?: ReelTileStatus;
  onPress?: () => void;
  /** Rótulo do reel pronto ("Reel de @marinac, 42 segundos"); os outros estados têm o próprio. */
  accessibilityLabel: string;
  testID?: string;
}

/** Proporção do tile de reel (ux.md §6.6): 9:16. */
const ASPECT = 16 / 9;
const TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.5)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 2,
} as const;

export const REEL_TILE_PROCESSING_LABEL = 'Reel processando';
export const REEL_TILE_FAILED_LABEL = 'Reel não publicado';

/**
 * Tile da grade de reels (p08, ux.md §6.14): 9:16, poster com o `mediaScrim` no rodapé e "▶ 0:42"
 * em `micro` branco a 8 da borda. Processando: fundo `greySoft`, spinner e "Processando". Falhou:
 * `circle-alert` e "Falhou"; o toque abre "Tentar de novo"/"Excluir" (no app).
 */
export function ReelTile({
  thumb,
  duration,
  width,
  status = 'ready',
  onPress,
  accessibilityLabel,
  testID = `reel-tile-${thumb.key}`,
}: ReelTileProps) {
  const height = Math.round(width * ASPECT);
  const label =
    status === 'processing'
      ? REEL_TILE_PROCESSING_LABEL
      : status === 'failed'
        ? REEL_TILE_FAILED_LABEL
        : accessibilityLabel;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(status === 'failed' && onPress !== undefined
        ? { accessibilityHint: 'Mostra as opções Tentar de novo e Excluir' }
        : {})}
      disabled={onPress === undefined}
      onPress={onPress}
      style={({ pressed }) => [{ width, height }, pressed && styles.pressed]}
    >
      {status === 'ready' ? (
        <>
          <PostImage source={thumb} width={width} height={height} compact />
          <MediaScrim testID={`${testID}-scrim`} />
          {duration === null ? null : (
            <View style={styles.duration} pointerEvents="none">
              <Icon name="play" size={12} color="white" filled />
              <Text
                variant="micro"
                color="white"
                tabularNums
                style={TEXT_SHADOW}
                testID={`${testID}-duration`}
              >
                {duration}
              </Text>
            </View>
          )}
        </>
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
  duration: {
    position: 'absolute',
    left: theme.space[8],
    bottom: theme.space[8],
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    boxShadow: theme.shadow.icon,
  },
});
