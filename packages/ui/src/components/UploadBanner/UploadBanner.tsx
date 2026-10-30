import { Image } from 'expo-image';
import { Pressable, StyleSheet, View } from 'react-native';

import { ProgressBar } from './ProgressBar';
import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { IconButton } from '../IconButton/IconButton';
import { Text } from '../Text/Text';

/**
 * `unavailable`: o reel falhou e o vídeo não está mais no aparelho (o "Tentar de novo" recriaria o
 * reel com o mesmo arquivo, 5.6); só dá para escolher o vídeo de novo ou descartar.
 */
export type UploadBannerStatus = 'uploading' | 'processing' | 'failed' | 'unavailable';

/** O que está sendo publicado: fotos (o padrão) ou um reel (a faixa diz "Processando o reel…"). */
export type UploadBannerKind = 'photo' | 'reel';

export interface UploadBannerProps {
  status: UploadBannerStatus;
  kind?: UploadBannerKind;
  /** Miniatura local da primeira foto ou da capa do reel (ou nada, em texto). */
  thumbUri?: string | null;
  /** Fotos já enviadas e total (ProgressBar determinada). */
  done?: number;
  total?: number;
  /** Fração já enviada (0 a 1), quando o app sabe os bytes (vídeo); vence `done`/`total`. */
  progress?: number;
  /** "Tentar de novo" na falha; "Escolher o vídeo de novo" com o vídeo indisponível. */
  onRetry?: () => void;
  /** ✕ na falha: descartar (o app confirma com um Alert). */
  onDiscard?: () => void;
  testID?: string;
}

export const UPLOAD_FAILED_TEXT = 'Não foi possível publicar.';
export const VIDEO_UNAVAILABLE_TEXT = 'O vídeo não está mais no aparelho.';
export const REEL_PROCESSING_TEXT = 'Processando o reel…';
export const PICK_VIDEO_AGAIN_LABEL = 'Escolher o vídeo de novo';

/**
 * "Publicando… 2 de 3", "Publicando…" ou "1 de 1" vira só "Publicando…". Reel: depois do envio,
 * "Processando o reel…" (o MediaConvert leva minutos, ux.md §5.3).
 */
export function uploadBannerText(
  status: UploadBannerStatus,
  done = 0,
  total = 0,
  kind: UploadBannerKind = 'photo',
): string {
  if (status === 'failed') {
    return UPLOAD_FAILED_TEXT;
  }
  if (status === 'unavailable') {
    return VIDEO_UNAVAILABLE_TEXT;
  }
  if (status === 'processing' && kind === 'reel') {
    return REEL_PROCESSING_TEXT;
  }
  if (status === 'uploading' && total > 1) {
    return `Publicando… ${Math.min(done + 1, total)} de ${total}`;
  }
  return 'Publicando…';
}

/**
 * Faixa de publicação (ux.md §5.3), no topo do feed e do perfil próprio: miniatura 40, texto e
 * barra de progresso; na falha, alerta `danger`, "Tentar de novo" e ✕.
 */
export function UploadBanner({
  status,
  kind = 'photo',
  thumbUri,
  done = 0,
  total = 0,
  progress,
  onRetry,
  onDiscard,
  testID = 'upload-banner',
}: UploadBannerProps) {
  const failed = status === 'failed' || status === 'unavailable';
  const text = uploadBannerText(status, done, total, kind);
  const retryLabel = status === 'unavailable' ? PICK_VIDEO_AGAIN_LABEL : 'Tentar de novo';
  const fraction =
    status !== 'uploading' ? undefined : (progress ?? (total > 0 ? done / total : undefined));

  return (
    <View testID={testID} style={styles.container}>
      <View style={styles.row} accessibilityLiveRegion="polite">
        <View style={styles.thumb}>
          {typeof thumbUri === 'string' && thumbUri !== '' ? (
            <Image
              source={{ uri: thumbUri }}
              contentFit="cover"
              accessible={false}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <Icon
              name={kind === 'reel' ? 'square-play' : 'align-left'}
              size={20}
              color="greyStrong"
            />
          )}
        </View>
        {failed ? <Icon name="circle-alert" size={16} color="danger" /> : null}
        <Text variant="bodySm" style={styles.flex} accessibilityRole={failed ? 'alert' : 'text'}>
          {text}
        </Text>
        {failed && onRetry !== undefined ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={retryLabel}
            hitSlop={8}
            onPress={onRetry}
            style={styles.retry}
          >
            <Text variant="buttonSm" color="blue">
              {retryLabel}
            </Text>
          </Pressable>
        ) : null}
        {failed && onDiscard !== undefined ? (
          <IconButton
            icon="x"
            size={20}
            accessibilityLabel="Descartar publicação"
            onPress={onDiscard}
          />
        ) : null}
      </View>
      {failed ? null : (
        <ProgressBar
          {...(fraction === undefined ? {} : { progress: fraction })}
          accessibilityLabel={text}
          testID={`${testID}-progress`}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[12],
    minHeight: 56,
    paddingLeft: theme.layout.screenX,
    paddingRight: theme.space[4],
    paddingVertical: theme.space[8],
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
    backgroundColor: theme.colors.greySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  retry: { flexShrink: 1 },
});
