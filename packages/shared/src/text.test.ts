import { describe, expect, it } from 'vitest';

import textCountFixtures from './fixtures/text-count.json' with { type: 'json' };
import { PostTextSchema } from './posts.ts';
import {
  countChars,
  isBlankText,
  normalizeText,
  POST_TEXT_MAX_LENGTH,
  postTextCounter,
} from './text.ts';

interface TextFixture {
  id: string;
  label: string;
  parts: { text: string; times?: number }[];
  count: number;
  valid: boolean;
}

/** Monta o texto de um caso das fixtures compartilhadas (TXT-02). */
function fixtureText(fixture: TextFixture): string {
  return fixture.parts.map((part) => part.text.repeat(part.times ?? 1)).join('');
}

const fixtures = textCountFixtures.cases as TextFixture[];

describe('countChars (A-09, TXT-04)', () => {
  it('conta code points, não unidades UTF-16', () => {
    expect('😀'.length).toBe(2);
    expect(countChars('😀')).toBe(1);
    expect(countChars('😀'.repeat(150))).toBe(150);
  });

  it('normaliza em NFC antes de contar (é decomposto vale 1)', () => {
    const decomposed = 'é';
    expect(decomposed.length).toBe(2);
    expect(countChars(decomposed)).toBe(1);
  });

  it('troca \r\n por \n', () => {
    expect(normalizeText('linha1\r\nlinha2')).toBe('linha1\nlinha2');
    expect(countChars('linha1\r\nlinha2')).toBe(13);
  });

  it('emoji composto conta como vários code points (documentado)', () => {
    expect(countChars('👨‍👩‍👧')).toBe(5);
    expect(countChars('🇧🇷')).toBe(2);
  });
});

describe('fixtures compartilhadas de contagem (TXT-01, TXT-02)', () => {
  it('cobrem os casos TXT-01a a TXT-01i', () => {
    const ids = new Set(fixtures.map((fixture) => fixture.id));
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
      expect(ids.has(`TXT-01${id}`)).toBe(true);
    }
  });

  it.each(fixtures.map((fixture) => [`${fixture.id} ${fixture.label}`, fixture] as const))(
    '[TXT-02] %s: contagem e validade iguais às do JSON',
    (_name, fixture) => {
      const text = fixtureText(fixture);
      expect(countChars(text)).toBe(fixture.count);
      expect(postTextCounter(text).count).toBe(fixture.count);
      expect(postTextCounter(text).canSubmit).toBe(fixture.valid);
      expect(PostTextSchema.safeParse(text).success).toBe(fixture.valid);
    },
  );
});

describe('isBlankText (TXT-01h)', () => {
  it.each([
    ['vazio', ''],
    ['espaços', '   '],
    ['quebras de linha', '\n\n'],
    ['tab e NBSP', '\t '],
    ['U+200B', '​​'],
    ['ZWJ, U+FEFF e U+2060', '‍﻿⁠'],
    ['braille em branco', '⠀'],
    ['seletor de variação sozinho', '️'],
    ['tag U+E0041', '\u{E0041}'],
  ])('[TXT-01h] %s conta como vazio', (_label, value) => {
    expect(isBlankText(value)).toBe(true);
  });

  it.each([['a'], [' a '], ['😀'], ['.']])('"%s" não é vazio', (value) => {
    expect(isBlankText(value)).toBe(false);
  });
});

describe('postTextCounter (TXT-03, ux.md §4.5)', () => {
  it('[TXT-03] cinza até 260, preto de 261 a 280, danger acima de 280', () => {
    expect(postTextCounter('a'.repeat(260))).toMatchObject({ tone: 'muted', canSubmit: true });
    expect(postTextCounter('a'.repeat(261))).toMatchObject({ tone: 'default', canSubmit: true });
    expect(postTextCounter('a'.repeat(279))).toMatchObject({ tone: 'default', canSubmit: true });
    expect(postTextCounter('a'.repeat(280))).toMatchObject({ tone: 'default', canSubmit: true });
    expect(postTextCounter('a'.repeat(281))).toMatchObject({ tone: 'danger', canSubmit: false });
  });

  it('[TXT-03] "Compartilhar" desabilitado com texto vazio ou só invisíveis', () => {
    expect(postTextCounter('')).toEqual({
      count: 0,
      max: POST_TEXT_MAX_LENGTH,
      tone: 'muted',
      canSubmit: false,
    });
    expect(postTextCounter('​ \n').canSubmit).toBe(false);
  });
});
