import type { VideoMime } from '@sussurro/shared';

/** Extensões que o worker aceita (os dois são ISO BMFF; o `.m4v` é um MP4). */
const BY_EXTENSION: Record<string, VideoMime> = {
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
};

const BY_MIME: Record<string, VideoMime> = {
  'video/mp4': 'video/mp4',
  'video/quicktime': 'video/quicktime',
  'video/x-m4v': 'video/mp4',
};

/**
 * Tipo do vídeo para o rascunho (`VideoMimeSchema`): o que o seletor informou ou, sem isso, a
 * extensão do arquivo. Outro tipo (WebM, 3GP, MKV…) → `null`, e a grade do Criar recusa o vídeo.
 */
export function videoMimeOf(mimeType: string | null | undefined, uri: string): VideoMime | null {
  const declared = mimeType?.trim().toLowerCase();
  if (declared !== undefined && declared !== '') {
    return BY_MIME[declared] ?? null;
  }
  const path = uri.split(/[?#]/)[0] ?? '';
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return path.includes('.') ? (BY_EXTENSION[extension] ?? null) : null;
}

/** Número positivo e finito, ou `null` (o seletor às vezes não informa o tamanho ou a duração). */
export function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Duração do seletor (milissegundos) em segundos, como vai no rascunho. */
export function durationSecondsFromMs(ms: number | null | undefined): number | null {
  const value = positiveOrNull(ms);
  return value === null ? null : value / 1000;
}
