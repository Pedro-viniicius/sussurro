/**
 * Monta `path?a=1&b=2` sem depender do `URLSearchParams` (incompleto em versões do React Native).
 * Valores `undefined` ficam de fora.
 */
export function withQuery(
  path: string,
  params: Record<string, string | number | undefined | null>,
): string {
  const parts = Object.entries(params)
    .filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null,
    )
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  return parts.length === 0 ? path : `${path}?${parts.join('&')}`;
}
