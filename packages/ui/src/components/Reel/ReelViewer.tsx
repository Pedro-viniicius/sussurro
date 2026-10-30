import { Image } from 'expo-image';
import { useVideoPlayer, type VideoPlayer, type VideoPlayerStatus, VideoView } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MediaScrim } from './MediaScrim';
import { formatInteger, pluralize } from '../../format/format';
import { useReducedMotion, useScreenReaderEnabled } from '../../preferences';
import { theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Button } from '../Button/Button';
import { Icon, type IconName } from '../Icon/Icon';
import { HeartButton } from '../Post/HeartButton';
import { type PostAuthorView, type PostRelation, RELATION_LABEL } from '../Post/types';
import { Text } from '../Text/Text';

export type ReelViewerStatus = 'ready' | 'processing' | 'failed';

export interface ReelViewerSource {
  /** Chave estável (id da mídia): as URLs assinadas mudam a cada resposta. */
  key: string;
  /** O MP4 (URL assinada ou arquivo local na prévia do Criar); `null` enquanto não está pronto. */
  uri: string | null;
  /** Poster (capa) mostrado enquanto o vídeo carrega. */
  posterUri: string | null;
}

export interface ReelViewerProps {
  source: ReelViewerSource;
  /** `processing`/`failed` só chegam ao autor (MID-09): mostram a mensagem no lugar do vídeo. */
  status?: ReelViewerStatus;
  /** Sem autor (prévia do Criar), o rodapé e a coluna de ações não aparecem. */
  author?: PostAuthorView;
  relation?: PostRelation;
  caption?: string | null;
  likeCount?: number;
  liked?: boolean;
  commentCount?: number;
  /** `false` para o criador (A-06): o coração vira só o número. */
  canLike?: boolean;
  /**
   * A tela está em foco. `false` pausa (comentários abertos por cima, outra tela); ao voltar, o vídeo
   * continua de onde parou, a não ser que a pessoa tenha pausado ou ele tenha terminado.
   */
  active?: boolean;
  /** `cover` (vertical, padrão) ou `contain` (vídeo deitado: não corta as laterais). */
  contentFit?: 'cover' | 'contain';
  onClose: () => void;
  onLike?: () => void;
  onOpenComments?: () => void;
  onOpenAuthor?: () => void;
  /** Menu ⋯ (Excluir nos próprios; Denunciar e Bloquear nos de outras contas). */
  onMore?: () => void;
  /** "Tentar de novo" no erro de reprodução (o app pode buscar uma URL nova). */
  onRetry?: () => void;
  /** Rótulo do vídeo; padrão "Reel de @x" (ou "Prévia do reel", sem autor). */
  accessibilityLabel?: string;
  testID?: string;
}

export const REEL_ERROR_MESSAGE = 'Não foi possível reproduzir este reel.';
export const REEL_PROCESSING_MESSAGE = 'Seu reel está sendo processado. Isso leva alguns minutos.';
export const REEL_FAILED_MESSAGE = 'Não foi possível publicar este reel.';
export const REEL_REPLAY_LABEL = 'Assistir de novo';
export const REEL_ENDED_ANNOUNCEMENT = 'O reel terminou.';

/** Arrastar para baixo além disto (ou rápido) fecha o visualizador. */
const CLOSE_DISTANCE = 120;
const CLOSE_VELOCITY = 1;
const ACTION_ICON = theme.size.icon.lg;
const WHITE_30 = 'rgba(255,255,255,0.3)';
const TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.5)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 2,
} as const;

function countLabel(count: number, one: string, other: string): string {
  return `${formatInteger(count)} ${pluralize(count, one, other)}`;
}

/** O player nativo é um objeto mutável do `expo-video` (o som muda pela propriedade). */
function applyMuted(player: VideoPlayer, muted: boolean): void {
  player.muted = muted;
}

/** Estado do player a partir dos eventos do `expo-video` (a fonte da verdade é o player nativo). */
function usePlayerState(player: VideoPlayer, screenReader: boolean) {
  const [status, setStatus] = useState<VideoPlayerStatus>(player.status);
  const [ended, setEnded] = useState(false);
  const [progress, setProgress] = useState(0);
  const screenReaderRef = useRef(screenReader);
  useEffect(() => {
    screenReaderRef.current = screenReader;
  });

  useEffect(() => {
    const subscriptions = [
      player.addListener('statusChange', ({ status: next }) => {
        setStatus(next);
      }),
      player.addListener('timeUpdate', ({ currentTime }) => {
        const duration = player.duration;
        if (duration > 0) setProgress(Math.min(1, Math.max(0, currentTime / duration)));
      }),
      // Fim do vídeo: para no último quadro. Nada abre outro reel (5.5 CA1, D-UX7).
      player.addListener('playToEnd', () => {
        setEnded(true);
        setProgress(1);
        if (screenReaderRef.current) {
          AccessibilityInfo.announceForAccessibility(REEL_ENDED_ANNOUNCEMENT);
        }
      }),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [player]);

  return { status, ended, setEnded, progress, setProgress };
}

/** Ícone branco 28 com o número embaixo (coluna da direita do wireframe 4.4). */
function CountAction({
  icon,
  count,
  label,
  onPress,
  testID,
}: {
  icon: IconName;
  count: number;
  label: string;
  onPress?: () => void;
  testID?: string;
}) {
  const content = (
    <>
      <Icon name={icon} size={ACTION_ICON} color="white" />
      <Text variant="micro" color="white" tabularNums style={TEXT_SHADOW}>
        {formatInteger(count)}
      </Text>
    </>
  );
  if (onPress === undefined) {
    return (
      <View style={styles.action} accessible accessibilityLabel={label} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

function WhiteIconButton({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
    >
      <Icon name={icon} size={ACTION_ICON} color="white" />
    </Pressable>
  );
}

interface PlaybackProps extends Omit<ReelViewerProps, 'source' | 'status' | 'onRetry' | 'testID'> {
  uri: string;
  posterUri: string | null;
  onRetry: () => void;
  testID: string;
}

/** Vídeo pronto: o player, o toque para pausar, o fim com "Assistir de novo" e as ações. */
function ReelPlayback({
  uri,
  posterUri,
  author,
  relation = 'self',
  caption,
  likeCount = 0,
  liked = false,
  commentCount = 0,
  canLike = true,
  active = true,
  contentFit = 'cover',
  onClose,
  onLike,
  onOpenComments,
  onOpenAuthor,
  onMore,
  onRetry,
  accessibilityLabel,
  testID,
}: PlaybackProps) {
  const insets = useSafeAreaInsets();
  const screenReader = useScreenReaderEnabled();
  const player = useVideoPlayer({ uri }, (created) => {
    // Nunca em loop nem em segundo plano; sem AirPlay e sem a notificação de mídia do sistema.
    created.loop = false;
    created.timeUpdateEventInterval = 0.25;
    created.staysActiveInBackground = false;
    created.showNowPlayingNotification = false;
    if (Platform.OS === 'ios') created.allowsExternalPlayback = false;
  });
  const { status, ended, setEnded, progress, setProgress } = usePlayerState(player, screenReader);
  const [userPaused, setUserPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [firstFrame, setFirstFrame] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);

  // Só o reel aberto toca (autoplay com a tela em foco); terminou, pausado ou fora de foco: parado.
  useEffect(() => {
    if (active && !userPaused && !ended) player.play();
    else player.pause();
  }, [active, ended, player, userPaused]);

  const failed = status === 'error';
  const loading = !failed && status === 'loading';
  const label =
    accessibilityLabel ?? (author === undefined ? 'Prévia do reel' : `Reel de @${author.handle}`);
  const relationLabel = RELATION_LABEL[relation];
  const hasCaption = typeof caption === 'string' && caption !== '';
  const paused = userPaused && !ended;

  const toggle = () => {
    if (ended || failed) return;
    setUserPaused((value) => !value);
  };

  const replay = () => {
    player.replay();
    setProgress(0);
    setUserPaused(false);
    setEnded(false);
  };

  const toggleMute = () => {
    const next = !muted;
    applyMuted(player, next);
    setMuted(next);
  };

  return (
    <>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit={contentFit}
        nativeControls={false}
        allowsPictureInPicture={false}
        fullscreenOptions={{ enable: false }}
        onFirstFrameRender={() => {
          setFirstFrame(true);
        }}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID={`${testID}-video`}
      />
      {firstFrame || posterUri === null ? null : (
        <Image
          source={{ uri: posterUri }}
          contentFit={contentFit}
          accessible={false}
          style={StyleSheet.absoluteFill}
          testID={`${testID}-poster`}
        />
      )}
      <MediaScrim coverage={0.4} testID={`${testID}-scrim`} />

      <View style={[styles.topBar, { top: insets.top }]}>
        <WhiteIconButton icon="x" label="Fechar" onPress={onClose} testID={`${testID}-fechar`} />
        <View style={styles.topRight}>
          {screenReader && !failed && !ended ? (
            // WCAG 2.2.2 (5.5 CA2): com leitor de tela, pausar é um botão explícito e fixo.
            <WhiteIconButton
              icon={paused ? 'play' : 'pause'}
              label={paused ? 'Reproduzir' : 'Pausar'}
              onPress={toggle}
              testID={`${testID}-pausar`}
            />
          ) : null}
          <WhiteIconButton
            icon={muted ? 'volume-x' : 'volume-2'}
            label={muted ? 'Ativar som' : 'Desativar som'}
            onPress={toggleMute}
            testID={`${testID}-som`}
          />
        </View>
      </View>

      <Pressable
        testID={`${testID}-superficie`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={paused ? 'Retoma o vídeo' : 'Pausa o vídeo'}
        accessibilityState={{ disabled: ended || failed }}
        onPress={toggle}
        style={[styles.surface, { top: insets.top + theme.layout.hitMin }]}
      />

      {loading ? (
        <View style={styles.center} pointerEvents="none" testID={`${testID}-carregando`}>
          <ActivityIndicator
            color={theme.colors.white}
            size="large"
            accessibilityLabel="Carregando"
          />
        </View>
      ) : null}
      {paused ? (
        // Pausado: o ▶ fica no centro enquanto o vídeo estiver parado (não some sozinho).
        <View style={styles.center} pointerEvents="none" testID={`${testID}-pausado`}>
          <View style={styles.bigIcon}>
            <Icon name="play" size={64} color="white" filled />
          </View>
        </View>
      ) : null}

      {ended ? (
        <View style={styles.overlay} pointerEvents="box-none" testID={`${testID}-fim`}>
          <Button
            variant="secondary"
            icon="rotate-ccw"
            label={REEL_REPLAY_LABEL}
            onPress={replay}
            testID={`${testID}-assistir-de-novo`}
          />
        </View>
      ) : null}

      {failed ? (
        <View
          style={[styles.message, styles.black]}
          pointerEvents="box-none"
          testID={`${testID}-erro`}
        >
          <Icon name="circle-alert" size={ACTION_ICON} color="white" />
          <Text variant="bodyStrong" color="white" align="center" accessibilityRole="alert">
            {REEL_ERROR_MESSAGE}
          </Text>
          <Button variant="secondary" size="sm" label="Tentar de novo" onPress={onRetry} />
        </View>
      ) : null}

      {author === undefined ? null : (
        <View style={[styles.column, { bottom: insets.bottom + 112 }]}>
          {canLike && onLike !== undefined ? (
            <View style={styles.action}>
              <HeartButton
                liked={liked}
                onPress={onLike}
                size={ACTION_ICON}
                color="white"
                testID={`${testID}-curtir`}
              />
              <Text
                variant="micro"
                color="white"
                tabularNums
                style={TEXT_SHADOW}
                accessibilityLabel={countLabel(likeCount, 'curtida', 'curtidas')}
              >
                {formatInteger(likeCount)}
              </Text>
            </View>
          ) : (
            <CountAction
              icon="heart"
              count={likeCount}
              label={countLabel(likeCount, 'curtida', 'curtidas')}
            />
          )}
          {onOpenComments === undefined ? null : (
            <CountAction
              icon="message-circle"
              count={commentCount}
              label={`Comentar, ${countLabel(commentCount, 'comentário', 'comentários')}`}
              onPress={onOpenComments}
              testID={`${testID}-comentar`}
            />
          )}
          {onMore === undefined ? null : (
            <WhiteIconButton
              icon="ellipsis"
              label="Mais opções"
              onPress={onMore}
              testID={`${testID}-mais`}
            />
          )}
        </View>
      )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + theme.space[12] }]}>
        {author === undefined ? null : (
          <View style={styles.footerText}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Abrir perfil de @${author.handle}${relationLabel === null ? '' : `, ${relationLabel}`}`}
              disabled={onOpenAuthor === undefined}
              onPress={onOpenAuthor}
              style={({ pressed }) => [styles.author, pressed && styles.pressed]}
            >
              <Avatar
                size={theme.size.avatar.sm}
                handle={author.handle}
                {...(author.name === undefined ? {} : { name: author.name })}
                {...(author.seed === undefined ? {} : { seed: author.seed })}
                {...(author.avatarUri === undefined ? {} : { uri: author.avatarUri })}
                decorative
              />
              <Text variant="bodySmStrong" color="white" numberOfLines={1} style={TEXT_SHADOW}>
                {relationLabel === null ? author.handle : `${author.handle} · ${relationLabel}`}
              </Text>
            </Pressable>
            {hasCaption ? (
              <View>
                <Text
                  variant="bodySm"
                  color="white"
                  style={TEXT_SHADOW}
                  testID={`${testID}-legenda`}
                  {...(expanded ? {} : { numberOfLines: 2 })}
                  onTextLayout={(event) => {
                    if (!expanded && event.nativeEvent.lines.length > 2) setTruncated(true);
                  }}
                >
                  {caption}
                </Text>
                {truncated && !expanded ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Ver a legenda inteira"
                    onPress={() => {
                      setExpanded(true);
                    }}
                  >
                    <Text variant="bodySmStrong" color="white" style={TEXT_SHADOW}>
                      mais
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        )}
        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel="Progresso do reel"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
          testID={`${testID}-progresso`}
        >
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
        </View>
      </View>
    </>
  );
}

/**
 * Visualizador de reels (ux.md §4.4 e §6.14), em tela cheia sobre fundo preto. Só o reel aberto
 * toca, com som; o toque pausa e retoma; no fim para no último quadro, escurece e mostra "Assistir
 * de novo". **Nunca avança para outro vídeo** (5.5 CA1, D-UX7): o componente só conhece um reel.
 * Com leitor de tela ligado, os controles não somem e há um botão explícito de pausar (5.5 CA2).
 * Arrastar para baixo fecha (o ✕ é a alternativa, WCAG 2.5.7).
 */
export function ReelViewer({
  source,
  status = 'ready',
  onRetry,
  testID = 'reel-viewer',
  ...props
}: ReelViewerProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [attempt, setAttempt] = useState(0);
  const [offset] = useState(() => new Animated.Value(0));
  const { onClose } = props;

  // `onClose` estável (useCallback no app): o responder só é recriado se ele ou o movimento mudar.
  const pan = useMemo(
    () =>
      PanResponder.create({
        // Só arrasto vertical para baixo: toques e arrastos laterais seguem para os controles.
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          gesture.dy > 12 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 2,
        onPanResponderMove: (_event, gesture) => {
          if (!reduceMotion) offset.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > CLOSE_DISTANCE || gesture.vy > CLOSE_VELOCITY) {
            onClose();
            return;
          }
          if (reduceMotion) offset.setValue(0);
          else Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start();
        },
        onPanResponderTerminate: () => {
          offset.setValue(0);
        },
      }),
    [offset, onClose, reduceMotion],
  );

  const message =
    status === 'processing'
      ? REEL_PROCESSING_MESSAGE
      : status === 'failed'
        ? REEL_FAILED_MESSAGE
        : REEL_ERROR_MESSAGE;

  return (
    <Animated.View
      testID={testID}
      style={[styles.screen, { transform: [{ translateY: offset }] }]}
      {...pan.panHandlers}
    >
      {status === 'ready' && source.uri !== null ? (
        <ReelPlayback
          key={`${source.key}#${String(attempt)}`}
          {...props}
          uri={source.uri}
          posterUri={source.posterUri}
          onRetry={() => {
            setAttempt((value) => value + 1);
            onRetry?.();
          }}
          testID={testID}
        />
      ) : (
        <>
          {source.posterUri === null ? null : (
            <Image
              source={{ uri: source.posterUri }}
              contentFit={props.contentFit ?? 'cover'}
              accessible={false}
              style={[StyleSheet.absoluteFill, styles.dim]}
            />
          )}
          <View style={[styles.topBar, { top: insets.top }]}>
            <WhiteIconButton
              icon="x"
              label="Fechar"
              onPress={props.onClose}
              testID={`${testID}-fechar`}
            />
          </View>
          <View style={styles.message} testID={`${testID}-${status}`}>
            <Icon
              name={status === 'processing' ? 'clock' : 'circle-alert'}
              size={ACTION_ICON}
              color="white"
            />
            <Text variant="bodyStrong" color="white" align="center">
              {message}
            </Text>
          </View>
        </>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.black, overflow: 'hidden' },
  black: { backgroundColor: theme.colors.black },
  dim: { opacity: 0.4 },
  pressed: { opacity: theme.opacity.pressed },
  topBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space[4],
    zIndex: 1,
  },
  topRight: { flexDirection: 'row', alignItems: 'center' },
  iconButton: {
    minWidth: theme.layout.hitMin,
    minHeight: theme.layout.hitMin,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: theme.shadow.icon,
  },
  surface: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigIcon: { boxShadow: theme.shadow.icon },
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: theme.colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[12],
    paddingHorizontal: theme.space[32],
  },
  column: {
    position: 'absolute',
    right: theme.space[12],
    alignItems: 'center',
    gap: theme.space[20],
  },
  action: { alignItems: 'center', minWidth: theme.layout.hitMin, boxShadow: theme.shadow.icon },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: theme.layout.screenX,
    gap: theme.space[8],
  },
  /** Espaço da coluna de ações à direita. */
  footerText: { paddingRight: 56, gap: theme.space[4] },
  author: { flexDirection: 'row', alignItems: 'center', gap: theme.space[8], minHeight: 44 },
  track: {
    height: theme.size.progressBar,
    backgroundColor: WHITE_30,
    overflow: 'hidden',
  },
  fill: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: theme.colors.white },
});
