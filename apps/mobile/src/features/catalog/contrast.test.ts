import { contrastRatio } from './contrast';

// Valores da tabela do ux.md §7.1.
describe('contrastRatio', () => {
  it.each([
    ['#000000', '#FFFFFF', 21],
    ['#737373', '#FFFFFF', 4.74],
    ['#0066FF', '#FFFFFF', 4.83],
    ['#666666', '#EFEFEF', 4.99],
    ['#4D94FF', '#FFFFFF', 3],
    ['#D32F2F', '#FFFFFF', 4.98],
  ])('%s sobre %s ≈ %f:1', (fg, bg, expected) => {
    expect(contrastRatio(fg, bg)).toBeCloseTo(expected, 1);
  });

  it('a ordem das cores não importa', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBe(21);
  });

  it('rejeita cor fora do formato #RRGGBB', () => {
    expect(() => contrastRatio('rgba(0,0,0,0.4)', '#FFFFFF')).toThrow(/Cor inválida/);
  });
});
