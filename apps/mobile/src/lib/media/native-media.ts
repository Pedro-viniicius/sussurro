import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';

import {
  MAX_IMAGE_SIDE,
  MAX_POSTER_SIDE,
  type MediaPorts,
  type PickedImage,
  type PickedVideo,
  type PreparedImage,
  UploadRejectedError,
  VideoUnavailableError,
} from './ports';
import { durationSecondsFromMs, positiveOrNull, videoMimeOf } from './video-file';
import { NetworkError } from '../api/errors';

let sequence = 0;

/** Qualidade do JPEG reenviado: o worker recomprime para q82 (MID-05). */
const JPEG_QUALITY = 0.9;

/**
 * Redução necessária para caber em `max` px no lado maior, mantendo a proporção. `null` quando já
 * cabe (nunca aumenta).
 */
export function fitWithin(
  width: number,
  height: number,
  max: number = MAX_IMAGE_SIDE,
): { width: number } | { height: number } | null {
  if (Math.max(width, height) <= max) {
    return null;
  }
  return width >= height ? { width: max } : { height: max };
}

async function fileSize(uri: string): Promise<number> {
  const blob = await (await fetch(uri)).blob();
  return blob.size;
}

/** Decodifica (sem carregar a imagem inteira), reduz para `max` px e grava um JPEG novo. */
async function renderJpeg(uri: string, max: number): Promise<PreparedImage> {
  let rendered = await ImageManipulator.manipulate(uri, {
    maxWidth: max,
    maxHeight: max,
  }).renderAsync();
  const resize = fitWithin(rendered.width, rendered.height, max);
  if (resize !== null) {
    rendered = await ImageManipulator.manipulate(rendered).resize(resize).renderAsync();
  }
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
  return {
    uri: saved.uri,
    mime: 'image/jpeg',
    sizeBytes: await fileSize(saved.uri),
    width: saved.width,
    height: saved.height,
  };
}

/**
 * Implementação real: `expo-image-picker` (PHPicker no iOS e Photo Picker no Android, sem pedir
 * acesso à biblioteca inteira), `expo-image-manipulator` (decodifica HEIC/PNG/WebP, reduz e grava um
 * JPEG novo, sem EXIF nem GPS) e `expo-video-thumbnails` (capa do reel). O servidor ainda limpa os
 * metadados (MID-05; no vídeo, o MediaConvert, A-21).
 */
export const nativeMedia: MediaPorts = {
  async pickImages({ limit, square = false }) {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: limit > 1,
      selectionLimit: limit,
      orderedSelection: true,
      exif: false,
      quality: 1,
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      ...(square ? { allowsEditing: true, aspect: [1, 1] as [number, number] } : {}),
    });
    if (result.canceled) {
      return [];
    }
    return result.assets.map((asset): PickedImage => {
      sequence += 1;
      return {
        key: `foto-${String(sequence)}`,
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        ...(asset.mimeType === undefined ? {} : { mimeType: asset.mimeType }),
      };
    });
  },

  async prepareImage(image) {
    // A decodificação já limita o tamanho (não carrega 48 MP na memória).
    return renderJpeg(image.uri, MAX_IMAGE_SIDE);
  },

  async uploadFile(target, file) {
    let response: Response;
    try {
      const body = await (await fetch(file.uri)).blob();
      response = await fetch(target.url, { method: target.method, headers: target.headers, body });
    } catch (error) {
      throw new NetworkError(error);
    }
    if (!response.ok) {
      throw new UploadRejectedError(response.status);
    }
  },

  async pickVideo() {
    // Só vídeos, um por vez, pelo seletor do sistema: nenhuma permissão de galeria. `Current`
    // entrega o arquivo como está (o `.mov` HEVC do iPhone não é convertido no aparelho: o
    // MediaConvert converte). Sem edição (cortar re-exportaria o vídeo no aparelho).
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: false,
      allowsEditing: false,
      exif: false,
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (asset === undefined) {
      return null;
    }
    sequence += 1;
    const video: PickedVideo = {
      key: `video-${String(sequence)}`,
      uri: asset.uri,
      mime: videoMimeOf(asset.mimeType, asset.uri),
      sizeBytes: positiveOrNull(asset.fileSize),
      durationS: durationSecondsFromMs(asset.duration),
      width: asset.width,
      height: asset.height,
    };
    return video;
  },

  async createPoster(video) {
    let frame: VideoThumbnails.VideoThumbnailsResult;
    try {
      // O primeiro quadro, como o poster do MediaConvert (ADR 0006).
      frame = await VideoThumbnails.getThumbnailAsync(video.uri, { time: 0, quality: 1 });
    } catch (error) {
      throw new VideoUnavailableError(error);
    }
    return renderJpeg(frame.uri, MAX_POSTER_SIDE);
  },

  uploadVideo(target, video, onProgress) {
    // XMLHttpRequest com `{ uri }` no corpo: o módulo de rede do React Native lê o arquivo do disco
    // (no Android, em streaming). O `fetch` + `blob()` das fotos carregaria até 200 MB na memória.
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(target.method, target.url);
      for (const [name, value] of Object.entries(target.headers)) {
        xhr.setRequestHeader(name, value);
      }
      if (onProgress !== undefined) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new UploadRejectedError(xhr.status));
      };
      xhr.onerror = () => {
        reject(new NetworkError(new Error('O envio do vídeo falhou.')));
      };
      xhr.ontimeout = xhr.onerror;
      xhr.onabort = xhr.onerror;
      xhr.send({ uri: video.uri } as unknown as XMLHttpRequestBodyInit);
    });
  },
};
