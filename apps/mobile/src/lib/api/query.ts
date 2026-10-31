type QueryParams = Record<string, string | number | undefined | null>;

/**
 * `a=1&b=2` sem depender do `URLSearchParams` (incompleto em versões do React Native). Valores
 * `undefined` e `null` ficam de fora.
 */
export function queryString(params: QueryParams): string {
  return Object.entries(params)
    .filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null,
    )
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/** Monta `path?a=1&b=2`; sem parâmetros, só o `path`. */
export function withQuery(path: string, params: QueryParams): string {
  const query = queryString(params);
  return query === '' ? path : `${path}?${query}`;
}
