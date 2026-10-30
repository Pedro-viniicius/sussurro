import { avatarColor, avatarInitials, fnv1a32 } from './avatar-color';

describe('fnv1a32', () => {
  it('bate com os vetores conhecidos do FNV-1a 32 bits', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
});

describe('avatarColor', () => {
  // CA4 (0.8): snapshot de 10 ids fixos. Mudar a função muda a cor de todo mundo no app.
  it('CA4 (0.8): é determinística (snapshot de 10 sementes)', () => {
    const seeds = [
      '0190f3c4-6a1e-7b2c-9d4e-5f6a7b8c9d0e',
      '0190f3c4-6a1e-7b2c-9d4e-5f6a7b8c9d0f',
      '01910000-0000-7000-8000-000000000001',
      '01910000-0000-7000-8000-000000000002',
      'marinac',
      'juprado',
      'cozinhadabia',
      'trilhasdosul',
      'helena',
      'caio.r',
    ];
    expect(Object.fromEntries(seeds.map((seed) => [seed, avatarColor(seed).name])))
      .toMatchInlineSnapshot(`
      {
        "0190f3c4-6a1e-7b2c-9d4e-5f6a7b8c9d0e": "periwinkle",
        "0190f3c4-6a1e-7b2c-9d4e-5f6a7b8c9d0f": "butter",
        "01910000-0000-7000-8000-000000000001": "lilac",
        "01910000-0000-7000-8000-000000000002": "sky",
        "caio.r": "butter",
        "cozinhadabia": "periwinkle",
        "helena": "lilac",
        "juprado": "peach",
        "marinac": "peach",
        "trilhasdosul": "mint",
      }
    `);
  });

  it('a mesma semente dá a mesma cor, sem diferenciar maiúsculas', () => {
    expect(avatarColor('MarinaC')).toEqual(avatarColor('marinac'));
  });
});

describe('avatarInitials', () => {
  it.each([
    ['Érica Lima', 'erica', 'ÉL'],
    ['Marina Costa Alves', 'marinac', 'MA'],
    ['Juliana', 'juprado', 'J'],
    ['  caio   ribeiro ', 'caio.r', 'CR'],
    [undefined, 'cozinhadabia', 'CO'],
    ['', '_9trilhas', '9T'],
  ])('CA4 (0.8): nome %j e handle %j → %j', (name, handle, expected) => {
    expect(avatarInitials(name, handle)).toBe(expected);
  });
});
