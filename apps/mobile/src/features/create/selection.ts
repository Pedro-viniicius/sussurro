import { type Me, MAX_PHOTOS_PER_POST } from '@sussurro/shared';
import { formatInteger, pluralize } from '@sussurro/ui';

import type { PickedImage } from '../../lib/media/ports';

/** Toast da 5ª foto (MID-01, 2.2 CA2, ux.md §6.14). */
export const PHOTO_LIMIT_MESSAGE = `Até ${String(MAX_PHOTOS_PER_POST)} fotos por publicação.`;

export interface PhotoSelection {
  /** Fotos trazidas do seletor do sistema, na ordem em que chegaram. */
  candidates: PickedImage[];
  /** Chaves escolhidas para o post, na ordem da seleção (1 a 4). */
  selected: string[];
}

export const EMPTY_SELECTION: PhotoSelection = { candidates: [], selected: [] };

/**
 * Toque numa foto da grade: desmarca (os números se reorganizam) ou marca no fim. A 5ª é recusada
 * (`rejected`), e a tela mostra o Toast.
 */
export function toggleSelection(
  state: PhotoSelection,
  key: string,
  max: number = MAX_PHOTOS_PER_POST,
): { state: PhotoSelection; rejected: boolean } {
  if (state.selected.includes(key)) {
    return {
      state: { ...state, selected: state.selected.filter((item) => item !== key) },
      rejected: false,
    };
  }
  if (state.selected.length >= max) {
    return { state, rejected: true };
  }
  return { state: { ...state, selected: [...state.selected, key] }, rejected: false };
}

/**
 * Fotos novas do seletor: entram na grade e já ficam marcadas enquanto houver lugar. As que
 * passam de 4 ficam desmarcadas (`rejected` → Toast).
 */
export function addCandidates(
  state: PhotoSelection,
  picked: readonly PickedImage[],
  max: number = MAX_PHOTOS_PER_POST,
): { state: PhotoSelection; rejected: boolean } {
  const room = Math.max(0, max - state.selected.length);
  const autoSelected = picked.slice(0, room).map((image) => image.key);
  return {
    state: {
      candidates: [...state.candidates, ...picked],
      selected: [...state.selected, ...autoSelected],
    },
    rejected: picked.length > room,
  };
}

/** As fotos marcadas, na ordem da seleção (a primeira é a capa). */
export function selectedImages(state: PhotoSelection): PickedImage[] {
  return state.selected
    .map((key) => state.candidates.find((image) => image.key === key))
    .filter((image): image is PickedImage => image !== undefined);
}

/** "Para suas 4 conexões" / "Para seus 2.418 seguidores" (p18, p20). */
export function audienceLabel(user: Me): string {
  if (user.accountType === 'personal') {
    const n = user.counts.connections;
    if (n === 0) return 'Para suas conexões';
    return `Para ${pluralize(n, 'sua', 'suas')} ${formatInteger(n)} ${pluralize(n, 'conexão', 'conexões')}`;
  }
  const n = user.counts.followers;
  if (n === 0) return 'Para seus seguidores';
  return `Para ${pluralize(n, 'seu', 'seus')} ${formatInteger(n)} ${pluralize(n, 'seguidor', 'seguidores')}`;
}
