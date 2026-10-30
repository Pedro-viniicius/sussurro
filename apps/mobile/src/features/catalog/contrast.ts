/** Luminância relativa do WCAG 2.x para uma cor #RRGGBB. */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) {
    throw new Error(`Cor inválida: ${hex} (esperado #RRGGBB)`);
  }
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => {
    const channel = parseInt(part ?? '0', 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razão de contraste do WCAG (1 a 21), com duas casas. Usado no catálogo (ux.md §6.15). */
export function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}
