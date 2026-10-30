import type { ImageMime, UploadTarget, VideoMime } from '@sussurro/shared';

/** Foto escolhida no seletor do sistema (ainda no formato e no tamanho originais). */
export interface PickedImage {
  /** Chave local, única na sessão do app. */
  key: string;
  uri: string;
  width: number;
  height: number;
  mimeType?: string;
}

/** Foto pronta para enviar: JPEG, no máximo 2160 px no lado maior, sem metadados. */
export interface PreparedImage {
  uri: string;
  mime: ImageMime;
  /** Tamanho exato do arquivo: vai no rascunho e fica assinado no `Content-Length` (MID-03). */
  sizeBytes: number;
  width: number;
  height: number;
}

/**
 * Vídeo escolhido no seletor do sistema para virar reel (5.3). O arquivo é enviado como está (o
 * worker converte): a duração, o tamanho e o tipo vêm do seletor e vão no rascunho (D10).
 */
export interface PickedVideo {
  /** Chave local, única na sessão do app. */
  key: string;
  /** Cópia do vídeo no cache do app (o seletor copia o arquivo; não há acesso à galeria). */
  uri: string;
  /** `video/mp4` ou `video/quicktime`; `null` se o aparelho informou outro tipo (recusado). */
  mime: VideoMime | null;
  /** Tamanho exato do arquivo; `null` se o seletor não informou (recusado). */
  sizeBytes: number | null;
  /** Duração em segundos; `null` se o seletor não informou (recusado). */
  durationS: number | null;
  width: number;
  height: number;
}

export interface PickOptions {
  /** Quantas fotos o seletor deixa escolher. */
  limit: number;
  /** Recorte quadrado (foto de perfil). */
  square?: boolean;
}

/** Progresso do envio (0 a 1), quando o sistema informa os bytes. */
export type UploadProgress = (fraction: number) => void;

/**
 * Acesso às fotos e aos vídeos do aparelho e ao S3 (ADR 0009). O app usa a implementação nativa
 * (`native-media.ts`); os testes trocam por dublês (`test-utils/fake-media.ts`).
 */
export interface MediaPorts {
  /** Seletor do sistema (sem permissão de biblioteca inteira). `[]` quando a pessoa cancela. */
  pickImages: (options: PickOptions) => Promise<PickedImage[]>;
  /** HEIC → JPEG e redução para no máximo 2160 px, antes do upload. */
  prepareImage: (image: PickedImage) => Promise<PreparedImage>;
  /** PUT direto na URL pré-assinada, com exatamente os cabeçalhos devolvidos pela API. */
  uploadFile: (
    target: Pick<UploadTarget, 'url' | 'method' | 'headers'>,
    file: PreparedImage,
  ) => Promise<void>;
  /** Seletor do sistema só com vídeos, um por vez (sem acesso à galeria). `null` = cancelou. */
  pickVideo: () => Promise<PickedVideo | null>;
  /**
   * Capa do reel: o primeiro quadro (`expo-video-thumbnails`), em JPEG de até 1280 px, sem
   * metadados. Falha com `VideoUnavailableError` se o vídeo não estiver mais no aparelho.
   */
  createPoster: (video: PickedVideo) => Promise<PreparedImage>;
  /** PUT do vídeo direto do arquivo (sem carregar 200 MB na memória do JavaScript). */
  uploadVideo: (
    target: Pick<UploadTarget, 'url' | 'method' | 'headers'>,
    video: PickedVideo,
    onProgress?: UploadProgress,
  ) => Promise<void>;
}

/** O S3 recusou o PUT (URL vencida, tamanho ou tipo diferente do assinado). */
export class UploadRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Upload recusado (${String(status)})`);
    this.name = 'UploadRejectedError';
  }
}

/** O vídeo escolhido não está mais no aparelho (o sistema limpou o cache) ou não abre. */
export class VideoUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Vídeo indisponível no aparelho', { cause });
    this.name = 'VideoUnavailableError';
  }
}

/** Lado maior das fotos enviadas (o worker ainda reduz para 1080 px). */
export const MAX_IMAGE_SIDE = 2160;

/** Lado maior da capa do reel (a saída do MediaConvert é 720×1280; o worker reduz para 720 px). */
export const MAX_POSTER_SIDE = 1280;
