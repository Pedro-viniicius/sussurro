import {
  CAPTION_MAX_LENGTH,
  countChars,
  formatReelDuration,
  isBlankText,
  MAX_IMAGE_BYTES,
  MAX_POSTER_BYTES,
  MAX_REEL_DURATION_S,
  postTextCounter,
  type TextCounterTone,
} from '@sussurro/shared';
import {
  Avatar,
  type ColorToken,
  type CreateMode,
  Icon,
  IconButton,
  MediaPickerGrid,
  ModePill,
  PostImage,
  ReelViewer,
  Text,
  theme,
  useFontScale,
  useToast,
} from '@sussurro/ui';
import { useNetworkState } from 'expo-network';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PUBLISHED_MESSAGE, usePublishing } from './PublishingProvider';
import {
  addReelCandidate,
  EMPTY_REEL_SELECTION,
  REEL_PROBLEM_MESSAGE,
  reelDraftInput,
  type ReelSelection,
  reelVideoProblem,
  selectedReel,
  toggleReelCandidate,
} from './reel-selection';
import { ReelPickerGrid } from './ReelPickerGrid';
import {
  addCandidates,
  audienceLabel,
  EMPTY_SELECTION,
  PHOTO_LIMIT_MESSAGE,
  type PhotoSelection,
  selectedImages,
  toggleSelection,
} from './selection';
import { isApiError, NetworkError } from '../../lib/api/errors';
import { messageForError } from '../../lib/error-messages';
import { useMedia } from '../../lib/media/MediaProvider';
import { type PreparedImage, VideoUnavailableError } from '../../lib/media/ports';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { EmailNotVerifiedNotice, useEmailNotVerified } from '../auth/email-verification';
import { createDraft, createReelDraft, createTextPost } from '../posts/api';
import { usePostStore } from '../posts/post-store';

/** Offline no Compartilhar (ux.md §5.3, 2.2 CA9): o modal fica aberto. */
export const SHARE_OFFLINE_MESSAGE = 'Sem internet. Sua publicação não foi enviada.';
export const DISCARD_DRAFT_TITLE = 'Descartar publicação?';
export const IMAGE_TOO_LARGE_MESSAGE = 'Cada imagem pode ter até 15 MB.';
export const POSTER_TOO_LARGE_MESSAGE = 'Não foi possível gerar a capa deste vídeo. Escolha outro.';

const TONE_COLOR: Record<TextCounterTone, ColorToken> = {
  muted: 'grey',
  default: 'black',
  danger: 'danger',
};

/** A legenda mostra o contador perto do limite. */
const CAPTION_COUNTER_FROM = CAPTION_MAX_LENGTH - 200;

/** Altura máxima da prévia 9:16 do reel ("altura limitada, centralizada", ux.md §4.5). */
const REEL_PREVIEW_MAX_HEIGHT = 360;

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function initialMode(value: string | undefined): CreateMode {
  return value === 'reel' || value === 'text' ? value : 'photo';
}

/**
 * Nova publicação (p18/p20, ux.md §4.5), pessoa e criador. FOTO: grade com as fotos trazidas do
 * seletor do sistema (1 a 4 marcadas, numeradas), prévia 4:5 e legenda; o envio continua em
 * segundo plano (faixa "Publicando…"). TEXTO: contador x/280 com os tons de `postTextCounter`.
 * REEL (5.3): um vídeo do seletor do sistema, até 90 s e 200 MB (D10), com a capa gerada no app e
 * a prévia 9:16; a faixa mostra o envio e "Processando o reel…".
 */
export function CreateScreen() {
  const params = useLocalSearchParams<{ modo?: string }>();
  const user = useSignedInUser();
  const { api, reloadUser } = useAuth();
  const toast = useToast();
  const media = useMedia();
  const store = usePostStore();
  const publishing = usePublishing();
  const emailNotVerified = useEmailNotVerified();
  const network = useNetworkState();
  const fontScale = useFontScale();
  const { width } = useWindowDimensions();

  const [mode, setMode] = useState<CreateMode>(() => initialMode(params.modo));
  const [text, setText] = useState('');
  const [caption, setCaption] = useState('');
  const [selection, setSelection] = useState<PhotoSelection>(EMPTY_SELECTION);
  const [reels, setReels] = useState<ReelSelection>(EMPTY_REEL_SELECTION);
  const [addingVideo, setAddingVideo] = useState(false);
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);

  const counter = postTextCounter(text);
  const captionCount = countChars(caption);
  const chosen = selectedImages(selection);
  const chosenReel = selectedReel(reels);
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const hasContent =
    text.length > 0 ||
    caption.length > 0 ||
    selection.candidates.length > 0 ||
    reels.candidates.length > 0;
  const captionOk = captionCount <= CAPTION_MAX_LENGTH;
  const canShare =
    !busy &&
    (mode === 'text'
      ? counter.canSubmit
      : mode === 'photo'
        ? chosen.length > 0 && captionOk
        : chosenReel !== undefined && captionOk);

  const requestClose = () => {
    if (!hasContent || busy) {
      close();
      return;
    }
    Alert.alert(DISCARD_DRAFT_TITLE, undefined, [
      { text: 'Continuar editando', style: 'cancel' },
      { text: 'Descartar', style: 'destructive', onPress: close },
    ]);
  };

  const pick = async () => {
    try {
      const picked = await media.pickImages({ limit: 4 });
      if (picked.length === 0) return;
      const result = addCandidates(selection, picked);
      setSelection(result.state);
      if (result.rejected) toast.show({ message: PHOTO_LIMIT_MESSAGE });
    } catch (error) {
      toast.show({ message: messageForError(error), variant: 'error' });
    }
  };

  const toggle = (key: string) => {
    const result = toggleSelection(selection, key);
    if (result.rejected) {
      toast.show({ message: PHOTO_LIMIT_MESSAGE });
      return;
    }
    setSelection(result.state);
    setPreviewIndex(0);
  };

  /** Um vídeo do seletor: a capa sai do primeiro quadro; fora dos limites, entra esmaecido. */
  const pickVideo = async () => {
    setAddingVideo(true);
    try {
      const video = await media.pickVideo();
      if (video === null) return;
      const poster = await media.createPoster(video);
      const problem = reelVideoProblem(video);
      setReels((current) => addReelCandidate(current, { video, poster, problem }));
      if (problem !== null) toast.show({ message: REEL_PROBLEM_MESSAGE[problem] });
    } catch (error) {
      toast.show({
        message:
          error instanceof VideoUnavailableError
            ? REEL_PROBLEM_MESSAGE.unreadable
            : messageForError(error),
        variant: 'error',
      });
    } finally {
      setAddingVideo(false);
    }
  };

  const toggleVideo = (key: string) => {
    const result = toggleReelCandidate(reels, key);
    if (result.rejected !== null) {
      toast.show({ message: REEL_PROBLEM_MESSAGE[result.rejected] });
      return;
    }
    setReels(result.state);
  };

  const fail = (error: unknown) => {
    if (error instanceof NetworkError) {
      toast.show({ message: SHARE_OFFLINE_MESSAGE, variant: 'error' });
    } else if (isApiError(error, 'EMAIL_NOT_VERIFIED')) {
      emailNotVerified();
    } else {
      toast.show({ message: messageForError(error), variant: 'error' });
    }
  };

  const publishedCaption = () => (isBlankText(caption) ? null : caption);

  const shareText = async () => {
    const post = await createTextPost(api, text);
    store.announceCreated(post);
    toast.show({ message: PUBLISHED_MESSAGE, variant: 'success' });
    void reloadUser().catch(() => undefined);
    close();
  };

  const sharePhotos = async () => {
    // Uma de cada vez: HEIC → JPEG e até 2160 px sem estourar a memória do aparelho.
    const files: PreparedImage[] = [];
    for (const image of chosen) {
      files.push(await media.prepareImage(image));
    }
    if (files.some((file) => file.sizeBytes > MAX_IMAGE_BYTES)) {
      toast.show({ message: IMAGE_TOO_LARGE_MESSAGE, variant: 'error' });
      return;
    }
    const draft = await createDraft(
      api,
      files.map((file) => ({ mime: file.mime, sizeBytes: file.sizeBytes })),
    );
    publishing.startPhotoPost({ draft, files, caption: publishedCaption() });
    close();
  };

  const shareReel = async () => {
    if (chosenReel === undefined) return;
    const { video, poster } = chosenReel;
    if (poster.sizeBytes > MAX_POSTER_BYTES) {
      toast.show({ message: POSTER_TOO_LARGE_MESSAGE, variant: 'error' });
      return;
    }
    // O rascunho leva o tipo, o tamanho exato e a duração do vídeo (D10) e o tamanho da capa.
    const draft = await createReelDraft(api, reelDraftInput(video, poster));
    publishing.startReel({ draft, video, poster, caption: publishedCaption() });
    close();
  };

  const share = async () => {
    if (!canShare) return;
    if (offline) {
      toast.show({ message: SHARE_OFFLINE_MESSAGE, variant: 'error' });
      return;
    }
    setBusy(true);
    try {
      if (mode === 'text') await shareText();
      else if (mode === 'photo') await sharePhotos();
      else await shareReel();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const previewHeight = Math.round((width * 5) / 4);
  const reelPreviewHeight = Math.min(Math.round((width * 16) / 9), REEL_PREVIEW_MAX_HEIGHT);
  const reelPreviewWidth = Math.round((reelPreviewHeight * 9) / 16);
  const inputStyle = {
    fontFamily: theme.fonts.regular,
    fontSize: theme.type.body.fontSize * fontScale,
    lineHeight: theme.type.body.lineHeight * fontScale,
  };

  const captionBlock = (
    <>
      <View style={styles.captionRow}>
        <Avatar
          size={theme.size.avatar.sm}
          handle={user.handle}
          name={user.name}
          seed={user.id}
          uri={user.avatarUrl}
          decorative
        />
        <TextInput
          testID="criar-legenda"
          value={caption}
          onChangeText={setCaption}
          placeholder="Escreva uma legenda…"
          placeholderTextColor={theme.colors.grey}
          accessibilityLabel="Legenda"
          multiline
          maxFontSizeMultiplier={theme.type.body.maxFontSizeMultiplier}
          style={[styles.captionInput, inputStyle]}
        />
      </View>
      {captionCount >= CAPTION_COUNTER_FROM ? (
        <Text
          variant="caption"
          align="right"
          tabularNums
          color={captionCount > CAPTION_MAX_LENGTH ? 'danger' : 'grey'}
          style={styles.captionCounter}
        >
          {`${String(captionCount)}/${String(CAPTION_MAX_LENGTH)}`}
        </Text>
      ) : null}
    </>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <IconButton icon="x" accessibilityLabel="Fechar" onPress={requestClose} />
        <Text variant="titleLg" accessibilityRole="header" style={styles.title} numberOfLines={1}>
          Nova publicação
        </Text>
        <Pressable
          testID="criar-compartilhar"
          accessibilityRole="button"
          accessibilityLabel="Compartilhar"
          accessibilityState={{ disabled: !canShare, busy }}
          disabled={!canShare}
          hitSlop={8}
          onPress={() => {
            void share();
          }}
          style={styles.share}
        >
          {busy ? (
            <ActivityIndicator color={theme.colors.blue} />
          ) : (
            <Text variant="bodyStrong" color={canShare ? 'blue' : 'blueMist'}>
              Compartilhar
            </Text>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          testID="criar-conteudo"
        >
          {user.emailVerified ? null : (
            <View style={styles.notice}>
              <EmailNotVerifiedNotice />
            </View>
          )}

          {mode === 'text' ? (
            <View style={styles.textMode} testID="criar-texto">
              <View style={styles.textRow}>
                <Avatar
                  size={theme.size.avatar.sm}
                  handle={user.handle}
                  name={user.name}
                  seed={user.id}
                  uri={user.avatarUrl}
                  decorative
                />
                <View style={styles.flex}>
                  <Text variant="bodyStrong">{user.handle}</Text>
                  <TextInput
                    testID="criar-texto-input"
                    value={text}
                    onChangeText={setText}
                    placeholder="No que você está pensando?"
                    placeholderTextColor={theme.colors.grey}
                    accessibilityLabel="Texto da publicação"
                    multiline
                    autoFocus
                    maxFontSizeMultiplier={theme.type.body.maxFontSizeMultiplier}
                    style={[styles.textInput, inputStyle]}
                  />
                </View>
              </View>
              <Text
                variant="caption"
                align="right"
                tabularNums
                color={TONE_COLOR[counter.tone]}
                testID="criar-contador"
                accessibilityLabel={`${String(counter.count)} de ${String(counter.max)} caracteres`}
                {...(counter.max - counter.count <= 20
                  ? { accessibilityLiveRegion: 'polite' as const }
                  : {})}
              >
                {`${String(counter.count)}/${String(counter.max)}`}
              </Text>
              <Text variant="bodySm" color="grey">
                {audienceLabel(user)}
              </Text>
            </View>
          ) : null}

          {mode === 'photo' ? (
            <View testID="criar-foto">
              {chosen.length === 0 ? (
                <View style={[styles.emptyPreview, { height: previewHeight }]}>
                  <Icon name="image" size={40} color="greyStrong" />
                  <Text variant="bodySm" color="greyStrong">
                    Escolha até 4 imagens abaixo
                  </Text>
                </View>
              ) : (
                <View testID="criar-previa">
                  <ScrollView
                    horizontal
                    pagingEnabled
                    showsHorizontalScrollIndicator={false}
                    onMomentumScrollEnd={(event) => {
                      setPreviewIndex(Math.round(event.nativeEvent.contentOffset.x / width));
                    }}
                  >
                    {chosen.map((image) => (
                      <PostImage
                        key={image.key}
                        source={{ key: image.key, uri: image.uri }}
                        width={width}
                        height={previewHeight}
                      />
                    ))}
                  </ScrollView>
                  {chosen.length > 1 ? (
                    <View style={styles.counterChip} pointerEvents="none">
                      <Text variant="micro" color="white" tabularNums>
                        {`${String(Math.min(previewIndex, chosen.length - 1) + 1)}/${String(chosen.length)}`}
                      </Text>
                    </View>
                  ) : null}
                </View>
              )}
              {captionBlock}
              <View style={styles.gridHeader}>
                <Text variant="titleSm">Fotos</Text>
                <Text variant="bodySm" color="grey">
                  {audienceLabel(user)}
                </Text>
              </View>
              <MediaPickerGrid
                items={selection.candidates}
                selected={selection.selected}
                onToggle={toggle}
                onAdd={() => {
                  void pick();
                }}
                width={width}
              />
            </View>
          ) : null}

          {mode === 'reel' ? (
            <View testID="criar-reel">
              <View style={[styles.reelPreviewArea, { height: reelPreviewHeight + 24 }]}>
                {chosenReel === undefined ? (
                  <View
                    style={[
                      styles.emptyReel,
                      { width: reelPreviewWidth, height: reelPreviewHeight },
                    ]}
                  >
                    <Icon name="video" size={40} color="greyStrong" />
                    <Text variant="bodySm" color="greyStrong" align="center">
                      {`Escolha um vídeo de até ${String(MAX_REEL_DURATION_S)} s abaixo`}
                    </Text>
                  </View>
                ) : (
                  <Pressable
                    testID="criar-reel-previa"
                    accessibilityRole="button"
                    accessibilityLabel="Assistir à prévia do reel"
                    onPress={() => {
                      setWatching(true);
                    }}
                    style={({ pressed }) => [
                      { width: reelPreviewWidth, height: reelPreviewHeight },
                      pressed && styles.pressed,
                    ]}
                  >
                    <PostImage
                      source={{ key: chosenReel.video.key, uri: chosenReel.poster.uri }}
                      width={reelPreviewWidth}
                      height={reelPreviewHeight}
                    />
                    <View style={styles.reelPlay} pointerEvents="none">
                      <Icon name="play" size={40} color="white" filled />
                    </View>
                  </Pressable>
                )}
              </View>
              {chosenReel === undefined || chosenReel.video.durationS === null ? null : (
                <Text variant="caption" color="grey" align="center" style={styles.reelHint}>
                  {`${formatReelDuration(chosenReel.video.durationS)} · toque para assistir`}
                </Text>
              )}
              {captionBlock}
              <View style={styles.gridHeader}>
                <Text variant="titleSm">Vídeos</Text>
                <Text variant="bodySm" color="grey">
                  {audienceLabel(user)}
                </Text>
              </View>
              <ReelPickerGrid
                candidates={reels.candidates}
                selected={reels.selected}
                onToggle={toggleVideo}
                onAdd={() => {
                  void pickVideo();
                }}
                adding={addingVideo}
                width={width}
              />
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <View style={styles.pill} pointerEvents="box-none">
        <ModePill value={mode} onChange={setMode} />
      </View>

      {chosenReel === undefined ? null : (
        <Modal
          visible={watching}
          animationType="slide"
          presentationStyle="fullScreen"
          supportedOrientations={['portrait']}
          onRequestClose={() => {
            setWatching(false);
          }}
        >
          <ReelViewer
            source={{
              key: chosenReel.video.key,
              uri: chosenReel.video.uri,
              posterUri: chosenReel.poster.uri,
            }}
            contentFit={chosenReel.video.width > chosenReel.video.height ? 'contain' : 'cover'}
            onClose={() => {
              setWatching(false);
            }}
            testID="criar-reel-player"
          />
        </Modal>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  flex: { flex: 1 },
  pressed: { opacity: theme.opacity.pressed },
  header: {
    height: theme.layout.headerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: theme.space[4],
    paddingRight: theme.layout.screenX,
    gap: theme.space[4],
  },
  title: { flex: 1 },
  share: { minHeight: theme.layout.hitMin, justifyContent: 'center' },
  content: { paddingBottom: 120 },
  notice: { paddingHorizontal: theme.layout.screenX, paddingBottom: theme.space[12] },
  textMode: { paddingHorizontal: theme.layout.screenX, paddingTop: theme.space[12], gap: 8 },
  textRow: { flexDirection: 'row', gap: theme.space[12] },
  textInput: { minHeight: 120, padding: 0, color: theme.colors.black, textAlignVertical: 'top' },
  emptyPreview: {
    backgroundColor: theme.colors.greySoft,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[12],
  },
  reelPreviewArea: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.greySoft,
  },
  emptyReel: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[12],
    paddingHorizontal: theme.space[12],
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  reelPlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: theme.shadow.icon,
  },
  reelHint: { paddingTop: theme.space[8] },
  counterChip: {
    position: 'absolute',
    top: theme.space[12],
    right: theme.space[12],
    backgroundColor: theme.colors.mediaChip,
    borderRadius: theme.radius.full,
    paddingVertical: theme.space[4],
    paddingHorizontal: theme.space[8],
  },
  captionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[12],
    paddingHorizontal: theme.layout.screenX,
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  captionInput: { flex: 1, paddingVertical: theme.space[12], color: theme.colors.black },
  captionCounter: { paddingHorizontal: theme.layout.screenX, paddingTop: 4 },
  gridHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.layout.screenX,
    paddingVertical: theme.space[12],
  },
  pill: { position: 'absolute', left: 0, right: 0, bottom: theme.space[24] },
});
