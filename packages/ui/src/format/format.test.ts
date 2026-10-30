import {
  formatInteger,
  formatPostTime,
  formatShortDate,
  formatShortTime,
  likesLabel,
  pluralize,
  spokenDuration,
  spokenShortTime,
  viewCommentsLabel,
} from './format';

// Datas montadas no fuso local (o mesmo que o app usa): o teste não depende do TZ da máquina.
const NOW = new Date(2026, 9, 29, 10, 0, 0);

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('2.10 CA1/CA2: tempo relativo do post (formatPostTime, sem Intl)', () => {
  it.each([
    [ago(30 * 1000), 'Agora'],
    [ago(1 * MIN), 'Há 1 minuto'],
    [ago(18 * MIN), 'Há 18 minutos'],
    [ago(59 * MIN), 'Há 59 minutos'],
    [ago(1 * HOUR), 'Há 1 hora'],
    [ago(3 * HOUR), 'Há 3 horas'],
    [ago(23 * HOUR + 59 * MIN), 'Há 23 horas'],
    // Ontem no calendário (28/10 às 06:00 = 28 h antes).
    [new Date(2026, 9, 28, 6, 0), 'Ontem'],
    // Anteontem: vira a data abreviada.
    [new Date(2026, 9, 27, 18, 0), '27 out'],
    [new Date(2026, 0, 3, 12, 0), '3 jan'],
    [new Date(2025, 11, 25, 12, 0), '25 dez 2025'],
  ])('%s → "%s"', (date, expected) => {
    expect(formatPostTime(date, NOW)).toBe(expected);
  });

  it('aceita ISO (como vem da API) e nunca mostra tempo negativo', () => {
    expect(formatPostTime(ago(18 * MIN).toISOString(), NOW)).toBe('Há 18 minutos');
    expect(formatPostTime(new Date(NOW.getTime() + 5 * MIN), NOW)).toBe('Agora');
  });
});

describe('2.10: tempo curto da thread e dos comentários (formatShortTime)', () => {
  it.each([
    [ago(10 * 1000), 'agora'],
    [ago(40 * MIN), '40 min'],
    [ago(3 * HOUR), '3 h'],
    [ago(6 * HOUR), '6 h'],
    [new Date(2026, 9, 28, 6, 0), 'ontem'],
    [new Date(2026, 9, 27, 6, 0), '2 d'],
    [new Date(2026, 9, 23, 6, 0), '6 d'],
    [new Date(2026, 9, 22, 6, 0), '22 out'],
  ])('%s → "%s"', (date, expected) => {
    expect(formatShortTime(date, NOW)).toBe(expected);
  });

  it('versão falada para o leitor de tela', () => {
    expect(spokenShortTime(ago(40 * MIN), NOW)).toBe('há 40 minutos');
    expect(spokenShortTime(new Date(2026, 9, 28, 6, 0), NOW)).toBe('ontem');
    expect(spokenShortTime(ago(5 * 1000), NOW)).toBe('agora');
  });

  it('formatShortDate cobre os 12 meses', () => {
    const months = Array.from({ length: 12 }, (_, month) =>
      formatShortDate(new Date(2026, month, 1), NOW),
    );
    expect(months).toEqual([
      '1 jan',
      '1 fev',
      '1 mar',
      '1 abr',
      '1 mai',
      '1 jun',
      '1 jul',
      '1 ago',
      '1 set',
      '1 out',
      '1 nov',
      '1 dez',
    ]);
  });
});

describe('2.10 CA1: singular e plural', () => {
  it.each([
    [0, '0 curtidas'],
    [1, '1 curtida'],
    [6, '6 curtidas'],
    [1234, '1.234 curtidas'],
  ])('likesLabel(%i) = "%s"', (count, expected) => {
    expect(likesLabel(count)).toBe(expected);
  });

  it.each([
    [1, 'Ver 1 comentário'],
    [2, 'Ver todos os 2 comentários'],
    [1500, 'Ver todos os 1.500 comentários'],
  ])('viewCommentsLabel(%i) = "%s"', (count, expected) => {
    expect(viewCommentsLabel(count)).toBe(expected);
  });

  it('pluralize e formatInteger', () => {
    expect(pluralize(1, 'foto', 'fotos')).toBe('foto');
    expect(pluralize(0, 'foto', 'fotos')).toBe('fotos');
    expect(formatInteger(8903)).toBe('8.903');
    expect(formatInteger(-3)).toBe('0');
  });

  it.each([
    [42, '42 segundos'],
    [1, '1 segundo'],
    [0.4, '0 segundos'],
    [60, '1 minuto'],
    [75.4, '1 minuto e 15 segundos'],
    [90, '1 minuto e 30 segundos'],
    [121, '2 minutos e 1 segundo'],
  ])('5.4: spokenDuration(%d) = "%s" (rótulo do ReelTile)', (seconds, expected) => {
    expect(spokenDuration(seconds)).toBe(expected);
  });
});
