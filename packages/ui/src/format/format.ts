/**
 * Formatação de números, plurais e datas em pt-BR **sem `Intl`**: o Hermes do app não tem todos os
 * recursos do `Intl` que o Node dos testes tem, e o resultado precisa ser igual nos dois
 * (história 2.10 CA2, MAN-FEED-01). Só aritmética e os métodos locais de `Date`.
 */

/** Meses abreviados (ux.md §8: "27 out"). */
export const MONTHS_SHORT = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Inteiro com ponto de milhar ("8.903", "1.234.567"). */
export function formatInteger(value: number): string {
  const n = Math.max(0, Math.trunc(value));
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Singular só para 1 (0 é plural em pt-BR: "0 curtidas"). */
export function pluralize(count: number, one: string, other: string): string {
  return count === 1 ? one : other;
}

/** "1 curtida", "6 curtidas", "1.234 curtidas" (ux.md §6.13 PostPhoto). */
export function likesLabel(count: number): string {
  return `${formatInteger(count)} ${pluralize(count, 'curtida', 'curtidas')}`;
}

/** "Ver 1 comentário", "Ver todos os 2 comentários" (ux.md §6.13 PostPhoto). */
export function viewCommentsLabel(count: number): string {
  return count === 1 ? 'Ver 1 comentário' : `Ver todos os ${formatInteger(count)} comentários`;
}

function toDate(value: Date | string): Date {
  return typeof value === 'string' ? new Date(value) : value;
}

/** Diferença em dias de calendário (fuso do aparelho) entre `date` e `now`. */
function calendarDaysBetween(date: Date, now: Date): number {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Arredonda para absorver a hora a mais ou a menos do horário de verão.
  return Math.round((end - start) / DAY_MS);
}

/** "27 out"; de outro ano, "27 out 2025". */
export function formatShortDate(value: Date | string, now: Date = new Date()): string {
  const date = toDate(value);
  const month = MONTHS_SHORT[date.getMonth()] ?? '';
  const base = `${date.getDate()} ${month}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

/**
 * Tempo do post de foto e do detalhe (ux.md §6.13 e §8): "Agora", "Há 1 minuto", "Há 18 minutos",
 * "Há 1 hora", "Há 3 horas", "Ontem" e, depois, a data ("27 out").
 */
export function formatPostTime(value: Date | string, now: Date = new Date()): string {
  const date = toDate(value);
  const diff = Math.max(0, now.getTime() - date.getTime());
  if (diff < MINUTE_MS) {
    return 'Agora';
  }
  if (diff < HOUR_MS) {
    const minutes = Math.floor(diff / MINUTE_MS);
    return `Há ${minutes} ${pluralize(minutes, 'minuto', 'minutos')}`;
  }
  if (diff < DAY_MS) {
    const hours = Math.floor(diff / HOUR_MS);
    return `Há ${hours} ${pluralize(hours, 'hora', 'horas')}`;
  }
  if (calendarDaysBetween(date, now) === 1) {
    return 'Ontem';
  }
  return formatShortDate(date, now);
}

/**
 * Tempo curto da thread de textos e dos comentários (p07, ux.md §8): "agora", "5 min", "3 h",
 * "ontem", "2 d" (até 6 dias) e, depois, a data ("27 out").
 */
export function formatShortTime(value: Date | string, now: Date = new Date()): string {
  const date = toDate(value);
  const diff = Math.max(0, now.getTime() - date.getTime());
  if (diff < MINUTE_MS) {
    return 'agora';
  }
  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)} min`;
  }
  if (diff < DAY_MS) {
    return `${Math.floor(diff / HOUR_MS)} h`;
  }
  const days = calendarDaysBetween(date, now);
  if (days <= 1) {
    return 'ontem';
  }
  if (days < 7) {
    return `${days} d`;
  }
  return formatShortDate(date, now);
}

/** Versão por extenso para o leitor de tela ("há 40 min" → "há 40 minutos"). */
export function spokenShortTime(value: Date | string, now: Date = new Date()): string {
  const long = formatPostTime(value, now);
  return long === 'Agora' ? 'agora' : long.replace(/^Há/, 'há').replace(/^Ontem$/, 'ontem');
}

/**
 * Duração do reel para o leitor de tela (ux.md §6.14 ReelTile: "42 segundos"): arredonda para o
 * segundo mais próximo, como o `formatReelDuration` da grade ("1:15" → "1 minuto e 15 segundos").
 */
export function spokenDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  const secondsPart = `${rest} ${pluralize(rest, 'segundo', 'segundos')}`;
  if (minutes === 0) {
    return secondsPart;
  }
  const minutesPart = `${minutes} ${pluralize(minutes, 'minuto', 'minutos')}`;
  return rest === 0 ? minutesPart : `${minutesPart} e ${secondsPart}`;
}
