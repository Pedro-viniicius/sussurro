import { describe, expect, it } from 'vitest';

import { BioSchema, MeSchema, PublicProfileSchema, UpdateMeRequestSchema } from './users.ts';

/** Forma de cada variante: chaves do objeto e chaves de `counts`. */
function shapeOf(schema: typeof PublicProfileSchema | typeof MeSchema) {
  return schema.options.map((option) => ({
    accountType: option.shape.accountType.value,
    keys: Object.keys(option.shape).sort(),
    counts: Object.keys(option.shape.counts.shape).sort(),
  }));
}

const OWN_KEYS = [
  'accountType',
  'avatarUrl',
  'bio',
  'counts',
  'createdAt',
  'email',
  'emailVerified',
  'handle',
  'id',
  'name',
];

describe('PublicProfileSchema', () => {
  it('[PERM-11] snapshot: só números em counts, nenhuma lista nem id de relacionamento', () => {
    // Mudar esta forma é mudar o contrato público: exige revisão (ADR 0004).
    expect(shapeOf(PublicProfileSchema)).toEqual([
      {
        accountType: 'personal',
        keys: ['accountType', 'avatarUrl', 'bio', 'counts', 'handle', 'name'],
        counts: ['connections', 'creators', 'posts'],
      },
      {
        accountType: 'creator',
        keys: ['accountType', 'avatarUrl', 'bio', 'counts', 'followedByMe', 'handle', 'name'],
        counts: ['followers', 'posts'],
      },
    ]);
  });

  it('[PERM-11] descarta campos extras (ids, e-mail, listas)', () => {
    const parsed = PublicProfileSchema.parse({
      handle: 'cozinhadabia',
      name: 'Beatriz Lemos',
      bio: null,
      avatarUrl: null,
      accountType: 'creator',
      counts: { posts: 6, followers: 2418, followerIds: ['x'] },
      followedByMe: true,
      id: 'secreto',
      email: 'bia@x.com',
      followers: [{ handle: 'helena' }],
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'accountType',
      'avatarUrl',
      'bio',
      'counts',
      'followedByMe',
      'handle',
      'name',
    ]);
    expect(parsed.counts).toEqual({ posts: 6, followers: 2418 });
  });

  it('counts de pessoal exige os três números', () => {
    const result = PublicProfileSchema.safeParse({
      handle: 'helena',
      name: 'Helena',
      bio: null,
      avatarUrl: null,
      accountType: 'personal',
      counts: { posts: 1, followers: 3 },
    });
    expect(result.success).toBe(false);
  });
});

describe('MeSchema', () => {
  it('é o perfil público mais id, e-mail, verificação e data de criação', () => {
    expect(shapeOf(MeSchema).map((variant) => variant.keys)).toEqual([OWN_KEYS, OWN_KEYS]);
  });
});

describe('UpdateMeRequestSchema', () => {
  it('[PERM-07] recusa accountType, handle, email, id e createdAt', () => {
    for (const extra of [
      { accountType: 'creator' },
      { handle: 'outro' },
      { email: 'x@x.com' },
      { id: 'x' },
      { createdAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      expect(UpdateMeRequestSchema.safeParse({ name: 'Ana', ...extra }).success).toBe(false);
    }
  });

  it('[TXT-04] nome 1–60 e bio até 150 (code points)', () => {
    expect(UpdateMeRequestSchema.safeParse({ name: 'a'.repeat(60) }).success).toBe(true);
    expect(UpdateMeRequestSchema.safeParse({ name: 'a'.repeat(61) }).success).toBe(false);
    expect(UpdateMeRequestSchema.safeParse({ bio: '😀'.repeat(150) }).success).toBe(true);
    expect(UpdateMeRequestSchema.safeParse({ bio: 'a'.repeat(151) }).success).toBe(false);
  });

  it('bio vazia ou só espaços vira null; null limpa a bio', () => {
    expect(BioSchema.parse('   ')).toBeNull();
    expect(UpdateMeRequestSchema.parse({ bio: null })).toEqual({ bio: null });
    expect(UpdateMeRequestSchema.parse({ bio: ' Café coado. ' })).toEqual({ bio: 'Café coado.' });
  });

  it('bio com \\r\\n é guardada com \\n', () => {
    expect(UpdateMeRequestSchema.parse({ bio: 'a\r\nb' }).bio).toBe('a\nb');
  });
});
