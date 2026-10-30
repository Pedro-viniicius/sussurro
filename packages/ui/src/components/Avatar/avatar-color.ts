import { theme } from '../../theme';

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** FNV-1a de 32 bits sobre os bytes UTF-8 da string (ux.md §6.3). */
export function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export type AvatarPaletteEntry = (typeof theme.avatarPalette)[number];

/**
 * Cor pastel determinística: `fnv1a32(seed em minúsculas) mod 6`. Use o `userId` (UUID) como
 * semente; só sem ele, o handle (o handle pode mudar e a cor mudaria junto).
 */
export function avatarColor(seed: string): AvatarPaletteEntry {
  const index = fnv1a32(seed.toLowerCase()) % theme.avatarPalette.length;
  // O índice está sempre dentro do array (mod do tamanho); o ?? só satisfaz o tipo.
  return theme.avatarPalette[index] ?? theme.avatarPalette[0];
}

/**
 * Iniciais: primeira letra da primeira e da última palavra do nome, em maiúsculas e com acento
 * ("Érica Lima" → "ÉL"); nome de uma palavra → 1 letra; sem nome → 2 primeiros caracteres
 * alfanuméricos do handle.
 */
export function avatarInitials(name: string | undefined, handle: string): string {
  const words = (name ?? '').trim().split(/\s+/u).filter(Boolean);
  const first = words[0];
  const last = words.at(-1);
  if (first !== undefined && last !== undefined) {
    const a = Array.from(first)[0] ?? '';
    if (words.length === 1) {
      return a.toLocaleUpperCase('pt-BR');
    }
    const b = Array.from(last)[0] ?? '';
    return `${a}${b}`.toLocaleUpperCase('pt-BR');
  }
  const alnum = Array.from(handle).filter((char) => /[\p{L}\p{N}]/u.test(char));
  return alnum.slice(0, 2).join('').toLocaleUpperCase('pt-BR');
}
