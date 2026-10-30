/**
 * Geometria exata do símbolo do Sussurro (briefing.md §6, ux.md §6.12). Sem dependências,
 * para ser usada pelo componente `<Logo>` e pelo script que gera ícone e splash (sharp).
 */
export const LOGO_VIEWBOX = '0 0 64 64';
export const LOGO_STROKE_WIDTH = 8;
export const LOGO_ARC_1 = 'M42.34 18.24 A11 11 0 1 0 24.22 29.78';
export const LOGO_ARC_2 = 'M21.66 45.76 A11 11 0 1 0 39.78 34.22';
export const LOGO_DOT = { cx: 32, cy: 32, r: 3 } as const;

export type LogoTone = 'default' | 'onBrand';

export interface LogoColors {
  arc1: string;
  arc2: string;
  dot: string;
  wordmark: string;
}

/** `default` sobre fundo claro; `onBrand` sobre azul ou preto (arcos branco e #B3D1FF). */
export function logoColors(tone: LogoTone): LogoColors {
  return tone === 'onBrand'
    ? { arc1: '#FFFFFF', arc2: '#B3D1FF', dot: '#FFFFFF', wordmark: '#FFFFFF' }
    : { arc1: '#0066FF', arc2: '#4D94FF', dot: '#000000', wordmark: '#000000' };
}

/** SVG do símbolo como texto (usado pelo `generate-icons.mjs`). */
export function logoMarkSvg(tone: LogoTone, sizePx = 64): string {
  const c = logoColors(tone);
  const stroke = `stroke-width="${LOGO_STROKE_WIDTH}" stroke-linecap="round" fill="none"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO_VIEWBOX}" width="${sizePx}" height="${sizePx}">`,
    `<path d="${LOGO_ARC_1}" stroke="${c.arc1}" ${stroke}/>`,
    `<path d="${LOGO_ARC_2}" stroke="${c.arc2}" ${stroke}/>`,
    `<circle cx="${LOGO_DOT.cx}" cy="${LOGO_DOT.cy}" r="${LOGO_DOT.r}" fill="${c.dot}"/>`,
    '</svg>',
  ].join('');
}
