/**
 * Regra única de contagem de caracteres (testes.md §6.9, A-09): normaliza em NFC, troca `\r\n`
 * por `\n` e conta code points. É o que o `char_length()` do Postgres conta, então os CHECKs do
 * banco e a validação do app e da API dão o mesmo número. Nunca use `string.length` (conta
 * unidades UTF-16: um emoji vale 2).
 */
export function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

/** Quantidade de code points depois de `normalizeText`. */
export function countChars(value: string): number {
  let count = 0;
  // O iterador de string percorre code points (pares substitutos contam 1).
  for (const _char of normalizeText(value)) {
    count++;
  }
  return count;
}

/** Limites de texto da Fase 2 (A-09, TXT-04). */
export const POST_TEXT_MAX_LENGTH = 280;
export const CAPTION_MAX_LENGTH = 2200;
export const COMMENT_MAX_LENGTH = 500;

/**
 * Code points que não aparecem na tela, além dos espaços do `\s`: hífen condicional, marcas de
 * direção, larguras zero (U+200B a U+200F, U+2060…), preenchimentos do hangul, braille em branco,
 * seletores de variação e caracteres de tag. Texto feito só deles conta como vazio (TXT-01h).
 * Faixas explícitas (sem `\p{…}`), para funcionar igual no Hermes do app.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xe0000, 0xe007f],
];

const WHITESPACE = /^\s$/;

function isInvisible(char: string): boolean {
  if (WHITESPACE.test(char)) {
    return true;
  }
  const codePoint = char.codePointAt(0) ?? 0;
  return INVISIBLE_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);
}

/** Vazio, só espaços, só quebras de linha ou só caracteres invisíveis (A-09, TXT-01h). */
export function isBlankText(value: string): boolean {
  // O iterador de string percorre code points (pares substitutos contam 1).
  for (const char of value) {
    if (!isInvisible(char)) {
      return false;
    }
  }
  return true;
}

/** Tom do contador da tela Criar (ux.md §4.5, TXT-03). */
export type TextCounterTone = 'muted' | 'default' | 'danger';

export interface TextCounter {
  /** Code points depois de `normalizeText`, contando espaços nas pontas (o que a API valida). */
  count: number;
  max: number;
  /** Até 260: `muted` (cinza); 261 a 280: `default` (preto); acima de 280: `danger`. */
  tone: TextCounterTone;
  /** "Compartilhar" habilitado: texto não vazio e dentro do limite. */
  canSubmit: boolean;
}

/** A partir deste número o contador deixa de ser cinza (ux.md §4.5). */
export const POST_TEXT_COUNTER_WARNING_FROM = 261;

/**
 * Estado do contador "x/280" da tela Criar (TXT-03). Usa a mesma contagem da API (TXT-02): a API
 * recusa exatamente o que o app mostra como `danger` ou vazio.
 */
export function postTextCounter(value: string): TextCounter {
  const normalized = normalizeText(value);
  const count = countChars(normalized);
  const tone: TextCounterTone =
    count > POST_TEXT_MAX_LENGTH
      ? 'danger'
      : count >= POST_TEXT_COUNTER_WARNING_FROM
        ? 'default'
        : 'muted';
  return {
    count,
    max: POST_TEXT_MAX_LENGTH,
    tone,
    canSubmit: !isBlankText(normalized) && count <= POST_TEXT_MAX_LENGTH,
  };
}
