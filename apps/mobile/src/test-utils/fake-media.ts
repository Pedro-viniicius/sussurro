import type { UploadTarget } from '@sussurro/shared';

import {
  type MediaPorts,
  type PickedImage,
  type PickedVideo,
  type PreparedImage,
  VideoUnavailableError,
} from '../lib/media/ports';

export interface FakeUpload {
  url: string;
  headers: Record<string, string>;
  file: PreparedImage;
}

export interface FakeVideoUpload {
  url: string;
  headers: Record<string, string>;
  video: PickedVideo;
}

let pickSequence = 0;

/** Fotos "escolhidas" no seletor falso. */
export function pickedImages(count: number): PickedImage[] {
  return Array.from({ length: count }, () => {
    pickSequence += 1;
    return {
      key: `foto-${String(pickSequence)}`,
      uri: `file:///galeria/IMG_${String(pickSequence)}.HEIC`,
      width: 4032,
      height: 3024,
      mimeType: 'image/heic',
    };
  });
}

/** Vídeo "escolhido" no seletor falso: `.mov` vertical de 42,5 s e 30 MB, salvo o que mudar. */
export function pickedVideo(overrides: Partial<PickedVideo> = {}): PickedVideo {
  pickSequence += 1;
  return {
    key: `video-${String(pickSequence)}`,
    uri: `file:///cache/ImagePicker/VID_${String(pickSequence)}.mov`,
    mime: 'video/quicktime',
    sizeBytes: 30_000_000,
    durationS: 42.5,
    width: 1080,
    height: 1920,
    ...overrides,
  };
}

/**
 * Dublê do acesso às fotos, aos vídeos e ao S3: o seletor devolve o que o teste enfileirou; a
 * preparação vira um JPEG "reduzido"; a capa do vídeo, um JPEG pequeno; o PUT é registrado (e pode
 * falhar sob comando).
 */
export function createFakeMedia() {
  const pickQueue: PickedImage[][] = [];
  const videoQueue: (PickedVideo | null)[] = [];
  const uploads: FakeUpload[] = [];
  const videoUploads: FakeVideoUpload[] = [];
  const prepared: PickedImage[] = [];
  const posters: PickedVideo[] = [];
  /** Vídeos que "sumiram" do aparelho (a capa falha com `VideoUnavailableError`). */
  const missing = new Set<string>();
  let uploadFailure: ((call: FakeUpload) => Error | null) | null = null;
  let videoUploadFailure: ((call: FakeVideoUpload) => Error | null) | null = null;

  const ports: MediaPorts = {
    pickImages: (options) => {
      const next = pickQueue.shift() ?? [];
      return Promise.resolve(next.slice(0, options.limit));
    },
    prepareImage: (image) => {
      prepared.push(image);
      return Promise.resolve({
        uri: `file:///cache/${image.key}.jpg`,
        mime: 'image/jpeg',
        sizeBytes: 1_000_000 + prepared.length,
        width: 2160,
        height: 1620,
      });
    },
    uploadFile: (target: Pick<UploadTarget, 'url' | 'method' | 'headers'>, file) => {
      const call: FakeUpload = { url: target.url, headers: { ...target.headers }, file };
      const failure = uploadFailure?.(call) ?? null;
      if (failure !== null) return Promise.reject(failure);
      uploads.push(call);
      return Promise.resolve();
    },
    pickVideo: () => Promise.resolve(videoQueue.shift() ?? null),
    createPoster: (video) => {
      if (missing.has(video.key)) return Promise.reject(new VideoUnavailableError());
      posters.push(video);
      return Promise.resolve({
        uri: `file:///cache/${video.key}-poster-${String(posters.length)}.jpg`,
        mime: 'image/jpeg',
        sizeBytes: 200_000 + posters.length,
        width: 720,
        height: 1280,
      });
    },
    uploadVideo: (target, video, onProgress) => {
      const call: FakeVideoUpload = { url: target.url, headers: { ...target.headers }, video };
      const failure = videoUploadFailure?.(call) ?? null;
      if (failure !== null) return Promise.reject(failure);
      onProgress?.(0.5);
      onProgress?.(1);
      videoUploads.push(call);
      return Promise.resolve();
    },
  };

  return {
    ports,
    uploads,
    videoUploads,
    prepared,
    posters,
    /** O próximo `pickImages` devolve estas fotos. */
    queuePick(images: PickedImage[]) {
      pickQueue.push(images);
    },
    /** O próximo `pickVideo` devolve este vídeo (`null` = cancelou). */
    queueVideo(video: PickedVideo | null) {
      videoQueue.push(video);
    },
    /** O vídeo sai do cache do aparelho: a capa (e o "Tentar de novo") falham. */
    loseVideo(video: PickedVideo) {
      missing.add(video.key);
    },
    /** Faz o PUT das fotos e da capa falhar enquanto a função devolver um erro. */
    failUploads(fn: ((call: FakeUpload) => Error | null) | null) {
      uploadFailure = fn;
    },
    /** Faz o PUT do vídeo falhar enquanto a função devolver um erro. */
    failVideoUploads(fn: ((call: FakeVideoUpload) => Error | null) | null) {
      videoUploadFailure = fn;
    },
  };
}

export type FakeMedia = ReturnType<typeof createFakeMedia>;
