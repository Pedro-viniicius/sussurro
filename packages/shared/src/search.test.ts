import { describe, expect, it } from 'vitest';

import {
  CREATOR_SEARCH_MAX_RESULTS,
  CreatorSearchItemSchema,
  CreatorSearchResultSchema,
  isCreatorSearchReady,
  normalizeCreatorSearch,
  SearchCreatorsQuerySchema,
} from './search.ts';

function parseQ(q: unknown) {
  return SearchCreatorsQuerySchema.safeParse({ q });
}

describe('busca de criadores: normalização e validação de q', () => {
  it('[BUS-01] 0, 1 e 2 caracteres são recusados; 3 passam', () => {
    for (const q of ['', 'a', 'ab']) {
      expect(parseQ(q).success).toBe(false);
    }
    expect(parseQ('abc')).toMatchObject({ success: true, data: { q: 'abc' } });
  });

  it('[BUS-02] o @ inicial sai antes de contar: "@ab" recusa, "@abc" busca abc', () => {
    expect(parseQ('@ab').success).toBe(false);
    expect(parseQ('@abc')).toMatchObject({ success: true, data: { q: 'abc' } });
    expect(normalizeCreatorSearch(' @ abc ')).toBe('abc');
  });

  it('[BUS-03] " Estu " vira "estu" (trim e minúsculas)', () => {
    expect(normalizeCreatorSearch(' Estu ')).toBe('estu');
    expect(parseQ(' Estu ')).toMatchObject({ success: true, data: { q: 'estu' } });
  });

  it('[BUS-06] "_" e "." valem como texto; %, aspas, espaço no meio e acento → recusados', () => {
    expect(parseQ('a__')).toMatchObject({ success: true, data: { q: 'a__' } });
    expect(parseQ('caio.r')).toMatchObject({ success: true, data: { q: 'caio.r' } });
    for (const q of ['a%b', "abc'--", 'ab c', 'estúdio', 'abc\\', 'a*bc']) {
      expect({ q, success: parseQ(q).success }).toEqual({ q, success: false });
    }
  });

  it('[BUS-09] q ausente, vazio, com mais de 30 caracteres ou repetido → recusado', () => {
    expect(SearchCreatorsQuerySchema.safeParse({}).success).toBe(false);
    expect(parseQ('').success).toBe(false);
    expect(parseQ('a'.repeat(30)).success).toBe(true);
    expect(parseQ('a'.repeat(31)).success).toBe(false);
    expect(parseQ(['abc', 'def']).success).toBe(false);
  });

  it('[PERM-08] parâmetro a mais na busca → recusado', () => {
    expect(SearchCreatorsQuerySchema.safeParse({ q: 'abc', userId: 'x' }).success).toBe(false);
  });

  it('[BUS-11] o app só chama a API com o termo pronto', () => {
    expect(isCreatorSearchReady('@es')).toBe(false);
    expect(isCreatorSearchReady('@est')).toBe(true);
    expect(isCreatorSearchReady('es t')).toBe(false);
  });
});

describe('resultado da busca', () => {
  it('[BUS-10] item só com @, nome, avatar, número de seguidores e followedByMe', () => {
    expect(Object.keys(CreatorSearchItemSchema.shape).sort()).toEqual([
      'avatarUrl',
      'followedByMe',
      'followersCount',
      'handle',
      'name',
    ]);
    const parsed = CreatorSearchItemSchema.parse({
      handle: 'estudioaurora',
      name: 'Estúdio Aurora',
      avatarUrl: null,
      followersCount: 3,
      followedByMe: false,
      id: 'secreto',
      email: 'x@x.com',
      accountType: 'creator',
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'avatarUrl',
      'followedByMe',
      'followersCount',
      'handle',
      'name',
    ]);
  });

  it('[BUS-07] no máximo 20 itens', () => {
    const item = {
      handle: 'x',
      name: 'X',
      avatarUrl: null,
      followersCount: 0,
      followedByMe: false,
    };
    expect(CREATOR_SEARCH_MAX_RESULTS).toBe(20);
    expect(
      CreatorSearchResultSchema.safeParse({ items: Array.from({ length: 20 }, () => item) })
        .success,
    ).toBe(true);
    expect(
      CreatorSearchResultSchema.safeParse({ items: Array.from({ length: 21 }, () => item) })
        .success,
    ).toBe(false);
  });
});
