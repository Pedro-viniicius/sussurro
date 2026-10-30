import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useReducedMotion } from '../../preferences';
import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { Text } from '../Text/Text';

export interface PostImageSource {
  /**
   * Chave estável da imagem (o `id` da mídia): as URLs assinadas mudam a cada resposta, então o
   * cache do `expo-image` usa esta chave, não a URL.
   */
  key: string;
  /** `null` enquanto a mídia não está pronta (só o dono vê o post nesse estado). */
  uri: string | null;
}

export interface PostImageProps {
  source: PostImageSource;
  width: number;
  height: number;
  /** Mostra o texto de erro (no post) ou só o ícone (miniaturas). */
  compact?: boolean;
  testID?: string;
}

/**
 * Foto com fundo `greySoft` enquanto carrega; na falha, `image-off` e "Não foi possível carregar a
 * foto", e o toque tenta de novo (ux.md §6.13 PostPhoto).
 */
export function PostImage({ source, width, height, compact = false, testID }: PostImageProps) {
  const reduceMotion = useReducedMotion();
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const failed = failedKey === source.key;
  const id = testID ?? `post-image-${source.key}`;

  return (
    <View style={[styles.frame, { width, height }]} testID={id}>
      {source.uri === null || failed ? null : (
        <Image
          key={`${source.key}-${attempt}`}
          testID={`${id}-img`}
          source={{ uri: source.uri, cacheKey: source.key }}
          recyclingKey={source.key}
          cachePolicy="memory-disk"
          contentFit="cover"
          transition={reduceMotion ? 0 : 150}
          accessible={false}
          style={StyleSheet.absoluteFill}
          onError={() => {
            setFailedKey(source.key);
          }}
        />
      )}
      {failed ? (
        <Pressable
          testID={`${id}-error`}
          accessibilityRole="button"
          accessibilityLabel="Não foi possível carregar a foto. Toque para tentar de novo."
          onPress={() => {
            setFailedKey(null);
            setAttempt((value) => value + 1);
          }}
          style={styles.error}
        >
          <Icon name="image-off" size={compact ? 20 : theme.size.icon.lg} color="greyStrong" />
          {compact ? null : (
            <Text variant="bodySm" color="greyStrong" align="center">
              Não foi possível carregar a foto
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: theme.colors.greySoft, overflow: 'hidden' },
  error: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[8],
    padding: theme.space[16],
  },
});
