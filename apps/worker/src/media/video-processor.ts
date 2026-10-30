import { MAX_REEL_DURATION_S, MAX_VIDEO_BYTES } from '@sussurro/shared';

import { PermanentMediaError } from './image-processor.js';
import { probeVideo, type VideoProbe } from './video-probe.js';
import { type ObjectStorage, ObjectTooLargeError } from '../infra/storage.js';

/**
 * Processamento do vídeo dos reels (ADR 0006, histórias 5.1 e 5.2), atrás de uma interface: em
 * produção o AWS MediaConvert (`mediaconvert`), em dev e nos testes o passthrough (`passthrough`).
 * A troca é só pelo `VIDEO_PROCESSOR`, sem mudar código (5.1 CA1).
 */
export type VideoProcessorName = 'passthrough' | 'mediaconvert';

/** O vídeo a processar: o original e o poster enviados pelo app, em `incoming/`. */
export interface VideoSource {
  mediaId: string;
  sourceKey: string;
  posterSourceKey: string;
  posterMime: string;
}

/**
 * Fim do processamento de um vídeo (ADR 0006): pronto, com as chaves de saída em `media/{id}/`, a
 * duração e o tamanho medidos; ou com falha.
 */
export interface VideoCompletion {
  mediaId: string;
  jobId: string;
  status: 'ready' | 'failed';
  outputKey?: string;
  posterKey?: string;
  durationS?: number;
  width?: number;
  height?: number;
  error?: string;
  /** Todas as saídas gravadas (para apagar se o vídeo for recusado depois de pronto). */
  outputKeys?: string[];
}

export interface VideoSubmission {
  jobId: string;
  /** Processadores síncronos (passthrough) já devolvem o resultado; o MediaConvert, não. */
  completion: VideoCompletion | null;
}

export abstract class VideoProcessor {
  abstract readonly name: VideoProcessorName;
  /**
   * O processador usa o poster enviado pelo app (passthrough). O MediaConvert gera o próprio poster
   * (um quadro do vídeo convertido), e o do app é apagado assim que o job é criado.
   */
  abstract readonly usesUploadedPoster: boolean;
  /** Começa o processamento. Arquivo inválido ou longo demais: `PermanentMediaError`. */
  abstract submit(source: VideoSource): Promise<VideoSubmission>;
  /**
   * Evento de fim de job da fila `video-events` (EventBridge). `null` = não é um evento deste app
   * (outro `userMetadata.app`, outro serviço ou estado intermediário): descartar sem efeito.
   */
  abstract parseCompletion(event: unknown): VideoCompletion | null;
}

/** Marca dos jobs deste app no MediaConvert (`userMetadata.app`; a regra do EventBridge filtra). */
export const VIDEO_APP_TAG = 'sussurro';

/**
 * Folga sobre os 90 s ao medir o arquivo: a duração do container costuma passar alguns
 * centésimos da que o seletor do aparelho informa (trilha de áudio um pouco mais longa).
 */
export const DURATION_TOLERANCE_S = 0.5;

/** Folga sobre os 200 MB assinados (o S3 já recusou corpo maior; defesa em profundidade). */
export const MAX_VIDEO_INPUT_BYTES = MAX_VIDEO_BYTES + 1024;

/** Saídas no S3 (servidas pelo CloudFront, só `media/*`). */
export function videoOutputKeys(mediaId: string) {
  return {
    video: `media/${mediaId}/video.mp4`,
    /** Poster do passthrough (o do app, sem metadados). */
    poster: `media/${mediaId}/poster.jpg`,
    /** Poster do MediaConvert (frame capture numera o arquivo). */
    mediaConvertPoster: `media/${mediaId}/poster.0000000.jpg`,
  };
}

/** Recusa a duração medida acima de 90 s (mais a folga): regra do D10 conferida no arquivo. */
export function assertReelDuration(durationS: number | undefined): number {
  if (durationS === undefined || !Number.isFinite(durationS) || durationS <= 0) {
    throw new PermanentMediaError('Não foi possível ler a duração do vídeo');
  }
  if (durationS > MAX_REEL_DURATION_S + DURATION_TOLERANCE_S) {
    throw new PermanentMediaError(
      `O vídeo tem ${durationS.toFixed(2)} s; o limite é ${String(MAX_REEL_DURATION_S)} s`,
    );
  }
  return Math.round(durationS * 100) / 100;
}

/**
 * Confere o vídeo em `incoming/` antes de processar: existe, cabe nos 200 MB, é MP4/MOV de verdade
 * (magic bytes) e tem até 90 s (D10). Lê só os cabeçalhos, por intervalo.
 */
export async function inspectStoredVideo(storage: ObjectStorage, key: string): Promise<VideoProbe> {
  const info = await storage.head(key);
  if (info === null) {
    throw new PermanentMediaError('O vídeo não está em incoming/');
  }
  if (info.size > MAX_VIDEO_INPUT_BYTES) {
    throw new ObjectTooLargeError(key, info.size);
  }
  const probe = await probeVideo(
    (start, length) => storage.getRange(key, start, length),
    info.size,
  );
  assertReelDuration(probe.durationS);
  return probe;
}
