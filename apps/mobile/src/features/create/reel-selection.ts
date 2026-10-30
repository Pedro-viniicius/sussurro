import {
  MAX_REEL_DURATION_S,
  MAX_VIDEO_BYTES,
  reelVideoLimitViolation,
  type ReelPosterRequest,
  type ReelVideoRequest,
} from '@sussurro/shared';

import type { PickedVideo, PreparedImage } from '../../lib/media/ports';

/**
 * Por que um vídeo não pode virar reel: os limites do D10 (`reelVideoLimitViolation`, a mesma regra
 * da API), um tipo que a API não aceita, ou um vídeo sem duração/tamanho informados pelo seletor.
 */
export type ReelVideoProblem = 'too_long' | 'too_large' | 'unsupported' | 'unreadable';

const MAX_VIDEO_MB = Math.round(MAX_VIDEO_BYTES / (1024 * 1024));

/** Rótulo no tile esmaecido da grade do Criar (ux.md §4.5: "Até 90 s"). */
export const REEL_PROBLEM_LABEL: Record<ReelVideoProblem, string> = {
  too_long: `Até ${String(MAX_REEL_DURATION_S)} s`,
  too_large: `Até ${String(MAX_VIDEO_MB)} MB`,
  unsupported: 'MP4 ou MOV',
  unreadable: 'Não abre',
};

/** Toast ao tocar num vídeo recusado (ou ao escolher um de novo para um reel que falhou). */
export const REEL_PROBLEM_MESSAGE: Record<ReelVideoProblem, string> = {
  too_long: `O reel pode ter até ${String(MAX_REEL_DURATION_S)} segundos.`,
  too_large: `O vídeo pode ter até ${String(MAX_VIDEO_MB)} MB.`,
  unsupported: 'Use um vídeo MP4 ou MOV.',
  unreadable: 'Não foi possível ler este vídeo. Escolha outro.',
};

export function reelVideoProblem(video: PickedVideo): ReelVideoProblem | null {
  if (video.durationS === null || video.sizeBytes === null) return 'unreadable';
  const limit = reelVideoLimitViolation({ durationS: video.durationS, sizeBytes: video.sizeBytes });
  if (limit !== null) return limit;
  return video.mime === null ? 'unsupported' : null;
}

/** O corpo do rascunho de reel (`CreateReelDraftRequestSchema`); só para um vídeo sem problema. */
export function reelDraftInput(
  video: PickedVideo,
  poster: PreparedImage,
): { video: ReelVideoRequest; poster: ReelPosterRequest } {
  if (video.mime === null || video.sizeBytes === null || video.durationS === null) {
    throw new Error('Vídeo sem tipo, tamanho ou duração não vira rascunho.');
  }
  return {
    video: { mime: video.mime, sizeBytes: video.sizeBytes, durationS: video.durationS },
    poster: { mime: poster.mime, sizeBytes: poster.sizeBytes },
  };
}

/** Um vídeo trazido do seletor para a grade do Criar, com a capa (miniatura) e o problema. */
export interface ReelCandidate {
  video: PickedVideo;
  poster: PreparedImage;
  problem: ReelVideoProblem | null;
}

export interface ReelSelection {
  candidates: ReelCandidate[];
  /** Seleção única (ux.md §4.5). */
  selected: string | null;
}

export const EMPTY_REEL_SELECTION: ReelSelection = { candidates: [], selected: null };

/** Vídeo novo do seletor: entra na grade e fica marcado se puder virar reel. */
export function addReelCandidate(state: ReelSelection, candidate: ReelCandidate): ReelSelection {
  return {
    candidates: [...state.candidates, candidate],
    selected: candidate.problem === null ? candidate.video.key : state.selected,
  };
}

/**
 * Toque num vídeo da grade: marca (seleção única) ou desmarca. Um vídeo fora dos limites é recusado
 * (`rejected`, e a tela mostra o motivo).
 */
export function toggleReelCandidate(
  state: ReelSelection,
  key: string,
): { state: ReelSelection; rejected: ReelVideoProblem | null } {
  const candidate = state.candidates.find((item) => item.video.key === key);
  if (candidate === undefined) return { state, rejected: null };
  if (candidate.problem !== null) return { state, rejected: candidate.problem };
  return {
    state: { ...state, selected: state.selected === key ? null : key },
    rejected: null,
  };
}

export function selectedReel(state: ReelSelection): ReelCandidate | undefined {
  return state.candidates.find((item) => item.video.key === state.selected);
}
