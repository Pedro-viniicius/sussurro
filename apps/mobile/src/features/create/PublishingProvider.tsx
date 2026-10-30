import type { Draft, Post } from '@sussurro/shared';
import { UploadBanner, useToast } from '@sussurro/ui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, View } from 'react-native';

import { REEL_PROBLEM_MESSAGE, reelDraftInput, reelVideoProblem } from './reel-selection';
import { isApiError } from '../../lib/api/errors';
import { messageForError } from '../../lib/error-messages';
import { useMedia } from '../../lib/media/MediaProvider';
import { type PickedVideo, type PreparedImage, VideoUnavailableError } from '../../lib/media/ports';
import { sleep, timing } from '../../lib/timing';
import { useAuth } from '../auth/AuthProvider';
import { useEmailNotVerified } from '../auth/email-verification';
import { createDraft, createReelDraft, deletePost, fetchPost, publishPost } from '../posts/api';
import { usePostStore } from '../posts/post-store';

export const PUBLISHED_MESSAGE = 'Publicado.';
export const DISCARD_TITLE = 'Descartar publicação?';

/**
 * Etapas visíveis na faixa (ux.md §5.3). `unavailable`: o reel precisa ser recriado (5.6), mas o
 * vídeo não está mais no aparelho; sobra escolher o vídeo de novo ou descartar.
 */
export type PublishStage = 'uploading' | 'processing' | 'failed' | 'unavailable';

export type PublishKind = 'photo' | 'reel';

export interface PublishJob {
  id: string;
  /** Conta que publicou (sair da conta esconde as faixas dela). */
  ownerId: string;
  kind: PublishKind;
  stage: PublishStage;
  /** Fotos já enviadas ao S3 e total (no reel: vídeo e capa). */
  uploaded: number;
  total: number;
  /** Reel: fração do vídeo já enviada (o sistema informa os bytes). */
  progress: number | null;
  thumbUri: string | null;
  /** O post no servidor (rascunho atual ou o reel que falhou e vai ser recriado). */
  postId: string | null;
}

type JobPayload =
  | { kind: 'photo'; files: PreparedImage[] }
  | { kind: 'reel'; video: PickedVideo; poster: PreparedImage | null };

interface JobData {
  payload: JobPayload;
  caption: string | null;
  draft: Draft | null;
  uploadedPositions: Set<number>;
  /** Reel: a capa já está no S3. */
  posterUploaded: boolean;
  /** O worker marcou o post como `failed`: tentar de novo cria outro rascunho. */
  processingFailed: boolean;
  /** Post que falhou e é apagado antes do rascunho novo (5.6: "Tentar de novo" recria). */
  replacesPostId: string | null;
  discarded: boolean;
}

interface PublishingContextValue {
  jobs: readonly PublishJob[];
  /** Começa (ou continua) o envio de um rascunho já criado: PUT de cada foto → publish → espera. */
  startPhotoPost: (input: { draft: Draft; files: PreparedImage[]; caption: string | null }) => void;
  /**
   * Reel (5.3): PUT do vídeo e da capa → publish → "Processando o reel…" até `published` ou
   * `failed`. O tile "Processando" aparece no perfil enquanto isso.
   */
  startReel: (input: {
    draft: Draft;
    video: PickedVideo;
    poster: PreparedImage;
    caption: string | null;
  }) => void;
  /**
   * Tile "Falhou" do perfil (5.6): recria o reel com o mesmo arquivo, se ele foi escolhido nesta
   * sessão e ainda está no aparelho; senão, pede o vídeo de novo ao seletor.
   */
  retryFailedReel: (post: Post) => void;
  retry: (jobId: string) => void;
  discard: (jobId: string) => void;
}

const PublishingContext = createContext<PublishingContextValue | null>(null);

/** Margem para não usar uma URL de upload que vence no meio do PUT. */
const EXPIRY_MARGIN_MS = 30_000;
const MAX_POLL_DELAY_MS = 5_000;
/** O MediaConvert leva minutos: a consulta do reel espera até 10 s entre uma vez e outra. */
const MAX_REEL_POLL_DELAY_MS = 10_000;
/** Falhas de rede seguidas na consulta antes de desistir (a faixa oferece "Tentar de novo"). */
const MAX_POLL_ERRORS = 5;

/** `details` do `MEDIA_NOT_UPLOADED`: fotos (ou o vídeo, posição 0) e a capa que não chegaram. */
function missingMedia(error: unknown): { positions: number[]; poster: boolean } {
  if (!isApiError(error, 'MEDIA_NOT_UPLOADED')) return { positions: [], poster: false };
  const details = error.details as { positions?: unknown; poster?: unknown } | undefined;
  return {
    positions: Array.isArray(details?.positions)
      ? details.positions.filter((value): value is number => typeof value === 'number')
      : [],
    poster: details?.poster === true,
  };
}

function draftUsable(job: JobData, now: number): boolean {
  const { draft } = job;
  if (draft === null) return false;
  const usable = (expiresAt: string) => Date.parse(expiresAt) - EXPIRY_MARGIN_MS > now;
  const uploads = draft.uploads
    .filter((upload) => !job.uploadedPositions.has(upload.position))
    .every((upload) => usable(upload.expiresAt));
  const poster =
    job.payload.kind !== 'reel' ||
    job.posterUploaded ||
    (draft.poster !== undefined && usable(draft.poster.expiresAt));
  return uploads && poster;
}

/** Apaga o post que falhou; já apagado (404) dá no mesmo. */
async function deleteIgnoringMissing(remove: () => Promise<unknown>): Promise<void> {
  try {
    await remove();
  } catch (error) {
    if (!isApiError(error, 'NOT_FOUND')) throw error;
  }
}

let jobSequence = 0;

/**
 * Publicação de fotos e reels em segundo plano (ADR 0009, ux.md §5.3): o modal fecha depois de
 * criar o rascunho, e a faixa no topo do feed e do perfil acompanha os PUTs, o `publish` e o
 * processamento, até `published` (Toast "Publicado.") ou `failed` ("Tentar de novo").
 */
export function PublishingProvider({ children }: { children: ReactNode }) {
  const { api, reloadUser, user } = useAuth();
  const media = useMedia();
  const store = usePostStore();
  const toast = useToast();
  const emailNotVerified = useEmailNotVerified();
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const data = useRef(new Map<string, JobData>());
  const mounted = useRef(true);
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback((jobId: string, changes: Partial<PublishJob>) => {
    if (!mounted.current) return;
    setJobs((list) => list.map((job) => (job.id === jobId ? { ...job, ...changes } : job)));
  }, []);

  const finish = useCallback((jobId: string) => {
    data.current.delete(jobId);
    if (mounted.current) setJobs((list) => list.filter((job) => job.id !== jobId));
  }, []);

  const waitForProcessing = useCallback(
    async (jobId: string, postId: string, maxDelay: number): Promise<Post | null> => {
      let delay = timing.pollIntervalMs;
      let errors = 0;
      for (;;) {
        await sleep(delay);
        if (data.current.get(jobId)?.discarded !== false) return null;
        try {
          const post = await fetchPost(api, postId);
          errors = 0;
          if (post.status !== 'processing') return post;
        } catch (error) {
          errors += 1;
          if (errors >= MAX_POLL_ERRORS) throw error;
        }
        delay = Math.min(delay * 1.5, maxDelay);
      }
    },
    [api],
  );

  /** Rascunho novo (primeiro envio, URL vencida ou recriação depois de `failed`). */
  const newDraft = useCallback(
    async (jobId: string, job: JobData): Promise<Draft | null> => {
      const { payload } = job;
      let poster: PreparedImage | null = null;
      if (payload.kind === 'reel') {
        // Recria com o mesmo arquivo: a capa sai do vídeo, então ela também confere se o vídeo
        // ainda está no aparelho (o sistema pode ter limpado o cache).
        try {
          poster = await media.createPoster(payload.video);
        } catch (error) {
          if (error instanceof VideoUnavailableError) {
            update(jobId, { stage: 'unavailable' });
            return null;
          }
          throw error;
        }
        payload.poster = poster;
        update(jobId, { thumbUri: poster.uri });
      }
      if (job.replacesPostId !== null) {
        const replaced = job.replacesPostId;
        await deleteIgnoringMissing(() => deletePost(api, replaced));
        // O tile "Falhou" sai do perfil na hora.
        store.remove(replaced);
        job.replacesPostId = null;
      }
      const draft =
        payload.kind === 'photo'
          ? await createDraft(
              api,
              payload.files.map((file) => ({ mime: file.mime, sizeBytes: file.sizeBytes })),
            )
          : poster === null
            ? null
            : await createReelDraft(api, reelDraftInput(payload.video, poster));
      if (draft === null) return null;
      job.draft = draft;
      job.uploadedPositions = new Set();
      job.posterUploaded = false;
      update(jobId, { postId: draft.postId });
      return draft;
    },
    [api, media, store, update],
  );

  const run = useCallback(
    async (jobId: string) => {
      const job = data.current.get(jobId);
      if (job === undefined) return;
      // Lido sempre de novo: o ✕ pode descartar o envio durante qualquer await.
      const stopped = (): boolean => job.discarded;
      try {
        if (job.processingFailed && job.draft !== null) {
          // O worker recusou: o post `failed` sai do perfil e tudo recomeça num rascunho novo.
          job.replacesPostId = job.draft.postId;
          job.draft = null;
          job.processingFailed = false;
        }
        const draft =
          job.draft !== null && draftUsable(job, Date.now())
            ? job.draft
            : await newDraft(jobId, job);
        if (draft === null || stopped()) return;
        update(jobId, { stage: 'uploading', uploaded: job.uploadedPositions.size });

        const { payload } = job;
        if (payload.kind === 'photo') {
          const uploads = [...draft.uploads].sort((a, b) => a.position - b.position);
          for (const upload of uploads) {
            if (stopped()) return;
            if (job.uploadedPositions.has(upload.position)) continue;
            const file = payload.files[upload.position];
            if (file === undefined) continue;
            await media.uploadFile(upload, file);
            job.uploadedPositions.add(upload.position);
            update(jobId, { uploaded: job.uploadedPositions.size });
          }
        } else {
          const video = draft.uploads.find((upload) => upload.position === 0);
          if (video !== undefined && !job.uploadedPositions.has(0)) {
            let shown = -1;
            await media.uploadVideo(video, payload.video, (fraction) => {
              // Uma atualização por ponto percentual (o sistema avisa muitas vezes por segundo).
              const percent = Math.floor(fraction * 100);
              if (percent === shown) return;
              shown = percent;
              update(jobId, { progress: fraction });
            });
            job.uploadedPositions.add(0);
          }
          if (stopped()) return;
          if (draft.poster !== undefined && payload.poster !== null && !job.posterUploaded) {
            await media.uploadFile(draft.poster, payload.poster);
            job.posterUploaded = true;
          }
        }
        if (stopped()) return;
        update(jobId, { stage: 'processing' });
        let post: Post;
        try {
          post = await publishPost(api, draft.postId, job.caption);
        } catch (error) {
          // A API diz o que não chegou ao S3: só isso é reenviado no "Tentar de novo".
          const missing = missingMedia(error);
          for (const position of missing.positions) job.uploadedPositions.delete(position);
          if (missing.poster) job.posterUploaded = false;
          throw error;
        }
        if (payload.kind === 'reel' && post.status === 'processing') {
          // O MediaConvert leva minutos: o tile "Processando" entra no topo do próprio perfil.
          store.announceCreated(post);
        }
        const finalPost =
          post.status === 'processing'
            ? await waitForProcessing(
                jobId,
                post.id,
                payload.kind === 'reel' ? MAX_REEL_POLL_DELAY_MS : MAX_POLL_DELAY_MS,
              )
            : post;
        if (finalPost === null || stopped()) return;
        if (finalPost.status === 'published') {
          finish(jobId);
          store.announceCreated(finalPost);
          toast.show({ message: PUBLISHED_MESSAGE, variant: 'success' });
          void reloadUser().catch(() => undefined);
          return;
        }
        job.processingFailed = true;
        // O tile do perfil passa a "Falhou" (só o autor vê, MID-10).
        if (payload.kind === 'reel') store.upsert([finalPost]);
        update(jobId, { stage: 'failed' });
      } catch (error) {
        if (stopped()) return;
        if (isApiError(error, 'EMAIL_NOT_VERIFIED')) emailNotVerified();
        update(jobId, { stage: 'failed' });
      }
    },
    [
      api,
      emailNotVerified,
      finish,
      media,
      newDraft,
      reloadUser,
      store,
      toast,
      update,
      waitForProcessing,
    ],
  );

  const addJob = useCallback(
    (job: JobData, view: Omit<PublishJob, 'id' | 'ownerId'>) => {
      jobSequence += 1;
      const jobId = `envio-${String(jobSequence)}`;
      data.current.set(jobId, job);
      setJobs((list) => [...list, { ...view, id: jobId, ownerId: user?.id ?? '' }]);
      void run(jobId);
    },
    [run, user],
  );

  const startPhotoPost = useCallback<PublishingContextValue['startPhotoPost']>(
    ({ draft, files, caption }) => {
      addJob(
        {
          payload: { kind: 'photo', files },
          caption,
          draft,
          uploadedPositions: new Set(),
          posterUploaded: false,
          processingFailed: false,
          replacesPostId: null,
          discarded: false,
        },
        {
          kind: 'photo',
          stage: 'uploading',
          uploaded: 0,
          total: files.length,
          progress: null,
          thumbUri: files[0]?.uri ?? null,
          postId: draft.postId,
        },
      );
    },
    [addJob],
  );

  const startReel = useCallback<PublishingContextValue['startReel']>(
    ({ draft, video, poster, caption }) => {
      addJob(
        {
          payload: { kind: 'reel', video, poster },
          caption,
          draft,
          uploadedPositions: new Set(),
          posterUploaded: false,
          processingFailed: false,
          replacesPostId: null,
          discarded: false,
        },
        {
          kind: 'reel',
          stage: 'uploading',
          uploaded: 0,
          total: 1,
          progress: 0,
          thumbUri: poster.uri,
          postId: draft.postId,
        },
      );
    },
    [addJob],
  );

  /** Seletor de vídeo para recriar um reel; `null` se a pessoa cancelou ou o vídeo não serve. */
  const pickValidVideo = useCallback(async (): Promise<PickedVideo | null> => {
    let video: PickedVideo | null;
    try {
      video = await media.pickVideo();
    } catch (error) {
      toast.show({ message: messageForError(error), variant: 'error' });
      return null;
    }
    if (video === null) return null;
    const problem = reelVideoProblem(video);
    if (problem !== null) {
      toast.show({ message: REEL_PROBLEM_MESSAGE[problem], variant: 'error' });
      return null;
    }
    return video;
  }, [media, toast]);

  /** Faixa "O vídeo não está mais no aparelho": escolhe outro e recria o mesmo reel. */
  const pickAgain = useCallback(
    async (jobId: string) => {
      const job = data.current.get(jobId);
      if (job?.payload.kind !== 'reel') return;
      const video = await pickValidVideo();
      if (video === null || job.discarded) return;
      job.payload = { kind: 'reel', video, poster: null };
      job.draft = null;
      update(jobId, { stage: 'uploading', progress: 0, uploaded: 0 });
      void run(jobId);
    },
    [pickValidVideo, run, update],
  );

  const retry = useCallback(
    (jobId: string) => {
      const view = jobsRef.current.find((job) => job.id === jobId);
      if (view?.stage === 'unavailable') {
        void pickAgain(jobId);
        return;
      }
      update(jobId, { stage: 'uploading' });
      void run(jobId);
    },
    [pickAgain, run, update],
  );

  const retryFailedReel = useCallback(
    (post: Post) => {
      // Envio desta sessão: o arquivo está guardado (o "Tentar de novo" da faixa faz o mesmo).
      for (const [jobId, job] of data.current) {
        if (!job.discarded && (job.draft?.postId ?? job.replacesPostId) === post.id) {
          retry(jobId);
          return;
        }
      }
      // Reel de outra sessão: o app não guarda o caminho do vídeo; pede o vídeo de novo.
      void (async () => {
        const video = await pickValidVideo();
        if (video === null) return;
        addJob(
          {
            payload: { kind: 'reel', video, poster: null },
            caption: post.caption,
            draft: null,
            uploadedPositions: new Set(),
            posterUploaded: false,
            processingFailed: false,
            replacesPostId: post.id,
            discarded: false,
          },
          {
            kind: 'reel',
            stage: 'uploading',
            uploaded: 0,
            total: 1,
            progress: 0,
            thumbUri: null,
            postId: post.id,
          },
        );
      })();
    },
    [addJob, pickValidVideo, retry],
  );

  const discard = useCallback(
    (jobId: string) => {
      Alert.alert(DISCARD_TITLE, undefined, [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Descartar',
          style: 'destructive',
          onPress: () => {
            const job = data.current.get(jobId);
            if (job !== undefined) {
              job.discarded = true;
              // O rascunho (ou o post que falhou) sai do servidor; sem rede, a limpeza de 24 h cuida.
              const postId = job.draft?.postId ?? job.replacesPostId;
              if (postId !== null) {
                void deletePost(api, postId)
                  .then(() => {
                    store.remove(postId);
                  })
                  .catch(() => undefined);
              }
            }
            finish(jobId);
          },
        },
      ]);
    },
    [api, finish, store],
  );

  const userId = user?.id;
  const value = useMemo(
    () => ({
      jobs: jobs.filter((job) => job.ownerId === userId),
      startPhotoPost,
      startReel,
      retryFailedReel,
      retry,
      discard,
    }),
    [jobs, userId, startPhotoPost, startReel, retryFailedReel, retry, discard],
  );
  return <PublishingContext.Provider value={value}>{children}</PublishingContext.Provider>;
}

export function usePublishing(): PublishingContextValue {
  const context = useContext(PublishingContext);
  if (context === null) {
    throw new Error('usePublishing precisa de um <PublishingProvider> acima na árvore.');
  }
  return context;
}

/** Faixas de publicação em andamento (topo do feed e do perfil próprio). */
export function PublishingBanners() {
  const { jobs, retry, discard } = usePublishing();
  if (jobs.length === 0) return null;
  return (
    <View testID="publishing-banners">
      {jobs.map((job) => (
        <UploadBanner
          key={job.id}
          testID={`upload-banner-${job.id}`}
          kind={job.kind}
          status={job.stage}
          thumbUri={job.thumbUri}
          done={job.uploaded}
          total={job.total}
          {...(job.progress === null ? {} : { progress: job.progress })}
          onRetry={() => {
            retry(job.id);
          }}
          onDiscard={() => {
            discard(job.id);
          }}
        />
      ))}
    </View>
  );
}
