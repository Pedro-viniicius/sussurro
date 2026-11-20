// E2E da busca de criadores (histórias 3.1 e 3.2; testes.md §6.3; A-04, A-31).
import { sql } from '@sussurro/db';
import { createUser, follow } from '@sussurro/db/testing';
import {
  type CreatorSearchResult,
  CreatorSearchResultSchema,
  ErrorResponseSchema,
} from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FollowsRepository } from '../../src/modules/follows/follows.repository.js';
import { directUser } from '../support/auth.js';
import { hasColumn, withShadowIdColumn } from '../support/shadow-column.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
});

function reader() {
  return directUser(t.app, t.database.db);
}

async function search(headers: Record<string, string>, q: string): Promise<CreatorSearchResult> {
  const response = await t.http.get('/v1/search/creators').query({ q }).set(headers).expect(200);
  return CreatorSearchResultSchema.parse(response.body);
}

const handlesOf = (result: CreatorSearchResult) => result.items.map((item) => item.handle);

describe('GET /search/creators: validação de q (BUS-01, BUS-02, BUS-06, BUS-09)', () => {
  it('[BUS-01] [BUS-09] 0, 1 e 2 caracteres, q ausente ou com mais de 30 → 400; 3 → 200', async () => {
    const { headers } = await reader();
    for (const q of ['', 'a', 'ab', '@ab', ' ab ', 'a'.repeat(31)]) {
      const response = await t.http
        .get('/v1/search/creators')
        .query({ q })
        .set(headers)
        .expect(400);
      expect(ErrorResponseSchema.parse(response.body).code).toBe('VALIDATION_ERROR');
    }
    await t.http.get('/v1/search/creators').set(headers).expect(400);
    // q repetido chega como lista: 400, nunca 500.
    await t.http.get('/v1/search/creators?q=abc&q=def').set(headers).expect(400);
    expect(await search(headers, 'abc')).toEqual({ items: [] });
  });

  it('[BUS-06] "_" é texto (não curinga); %, aspas e caracteres fora de [a-z0-9._] → 400, nunca 500', async () => {
    await createUser(t.database.db, { handle: 'a_bcd', accountType: 'creator' });
    await createUser(t.database.db, { handle: 'axbcd', accountType: 'creator' });
    const { headers } = await reader();
    expect(handlesOf(await search(headers, 'a_b'))).toEqual(['a_bcd']);
    expect(handlesOf(await search(headers, 'a__'))).toEqual([]);
    for (const q of ['a%b', "abc'--", 'ab c', 'estúdio', 'a\\bc', '%%%']) {
      const response = await t.http.get('/v1/search/creators').query({ q }).set(headers);
      expect({ q, status: response.status }).toEqual({ q, status: 400 });
    }
  });

  it('[PERM-08] parâmetro a mais → 400', async () => {
    const { headers } = await reader();
    await t.http
      .get('/v1/search/creators')
      .query({ q: 'abc', userId: 'x' })
      .set(headers)
      .expect(400);
  });
});

describe('GET /search/creators: resultado (BUS-03 a BUS-08, BUS-10)', () => {
  it('[BUS-04] só criadores aparecem; a conta pessoal com o mesmo prefixo nunca', async () => {
    await createUser(t.database.db, { handle: 'estudante' });
    await createUser(t.database.db, { handle: 'estudioaurora', accountType: 'creator' });
    const { headers } = await reader();
    expect(handlesOf(await search(headers, 'estu'))).toEqual(['estudioaurora']);
  });

  it('[BUS-03] [BUS-02] maiúsculas, espaços e o @ inicial dão o mesmo resultado de "estu"', async () => {
    await createUser(t.database.db, { handle: 'estudioaurora', accountType: 'creator' });
    const { headers } = await reader();
    const expected = await search(headers, 'estu');
    for (const q of [' Estu ', '@estu', ' @ESTU', '@Estu ']) {
      expect(await search(headers, q)).toEqual(expected);
    }
  });

  it('[BUS-05] @ exato de conta pessoal = [] idêntico ao de @ inexistente (status, corpo e headers)', async () => {
    await createUser(t.database.db, { handle: 'helena' });
    const { headers } = await reader();
    const personal = await t.http.get('/v1/search/creators?q=helena').set(headers);
    const missing = await t.http.get('/v1/search/creators?q=helenx').set(headers);
    expect(personal.status).toBe(200);
    expect(personal.status).toBe(missing.status);
    expect(personal.text).toBe('{"items":[]}');
    expect(personal.text).toBe(missing.text);
    const withoutDate = (raw: Record<string, string>) => {
      const { date: _date, ...rest } = raw;
      return rest;
    };
    expect(withoutDate(personal.headers as Record<string, string>)).toEqual(
      withoutDate(missing.headers as Record<string, string>),
    );
  });

  it('[BUS-05] tempo de resposta indistinguível (indicativo: mediana de 30 amostras intercaladas)', async () => {
    await createUser(t.database.db, { handle: 'helena' });
    const { headers } = await reader();
    const timings = { personal: [] as number[], missing: [] as number[] };
    for (let index = 0; index < 30; index++) {
      for (const [kind, q] of [
        ['personal', 'helena'],
        ['missing', 'helenx'],
      ] as const) {
        const started = performance.now();
        await t.http.get(`/v1/search/creators?q=${q}`).set(headers).expect(200);
        timings[kind].push(performance.now() - started);
      }
      // Fica abaixo do rate limit da busca (60/min).
      t.clock.advance(5_000);
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;
    // Mesma consulta nos dois casos (o tipo de conta está no WHERE): a diferença é ruído.
    expect(Math.abs(median(timings.personal) - median(timings.missing))).toBeLessThan(15);
  });

  it('[BUS-07] 25 criadores com o mesmo prefixo → 20, em ordem alfabética do @, estável', async () => {
    const handles = Array.from(
      { length: 22 },
      (_, index) => `trilha${String(index).padStart(2, '0')}`,
    );
    handles.push('trilha.norte', 'trilha_sul', 'trilhaz');
    for (const handle of [...handles].reverse()) {
      await createUser(t.database.db, { handle, accountType: 'creator' });
    }
    const { headers } = await reader();
    const first = await search(headers, 'trilha');
    // Ordem de bytes (collation "C"): '.' < dígitos < '_' < letras.
    expect(handlesOf(first)).toEqual([...handles].sort().slice(0, 20));
    expect(handlesOf(first)[0]).toBe('trilha.norte');
    expect(await search(headers, 'trilha')).toEqual(first);
  });

  it('[BUS-08] criador excluído não aparece; criador chamando a busca → 403', async () => {
    await createUser(t.database.db, {
      handle: 'estudioantigo',
      accountType: 'creator',
      deletedAt: new Date(),
    });
    await createUser(t.database.db, { handle: 'estudioaurora', accountType: 'creator' });
    const { headers } = await reader();
    expect(handlesOf(await search(headers, 'estudio'))).toEqual(['estudioaurora']);

    const creator = await directUser(t.app, t.database.db, { accountType: 'creator' });
    const denied = await t.http
      .get('/v1/search/creators?q=estudio')
      .set(creator.headers)
      .expect(403);
    expect(ErrorResponseSchema.parse(denied.body).code).toBe('ACCOUNT_TYPE_NOT_ALLOWED');
  });

  it('[BUS-10] item só com @, nome, avatar, número de seguidores e followedByMe', async () => {
    const creator = await createUser(t.database.db, {
      handle: 'estudioaurora',
      name: 'Estúdio Aurora',
      accountType: 'creator',
    });
    const other = await createUser(t.database.db, {
      handle: 'estudiovinil',
      accountType: 'creator',
    });
    const fan = await createUser(t.database.db);
    await follow(t.database.db, fan, creator);
    const { user, headers } = await reader();
    await follow(t.database.db, user, creator);

    const response = await t.http.get('/v1/search/creators?q=estudio').set(headers).expect(200);
    expect(response.body).toEqual({
      items: [
        {
          handle: 'estudioaurora',
          name: 'Estúdio Aurora',
          avatarUrl: null,
          followersCount: 2,
          followedByMe: true,
        },
        {
          handle: other.handle,
          name: other.name,
          avatarUrl: null,
          followersCount: 0,
          followedByMe: false,
        },
      ],
    });
  });
});

describe('busca: followedByMe com a coluna de fora (R25)', () => {
  it('[BUS-10] (R25) o followedByMe lê o users.id de fora: com uma coluna id em follows (só numa transação desfeita no fim), o criador seguido continua true e o outro, false', async () => {
    const followed = await createUser(t.database.db, {
      handle: 'estudioaurora',
      accountType: 'creator',
    });
    const other = await createUser(t.database.db, {
      handle: 'estudiovinil',
      accountType: 'creator',
    });
    const viewer = await createUser(t.database.db);
    await follow(t.database.db, viewer, followed);
    const expected = { estudioaurora: true, estudiovinil: false };
    const followedByHandle = (rows: readonly { handle: string; followedByMe: boolean }[]) =>
      Object.fromEntries(rows.map((row) => [row.handle, row.followedByMe]));

    // Controle, com a tabela das migrations.
    const plain = await t.app
      .get(FollowsRepository)
      .searchCreators(viewer.id, 'estudio', 20, sql`true`);
    expect(followedByHandle(plain)).toEqual(expected);
    expect(plain.map((row) => row.id)).toEqual([followed.id, other.id]);

    // Com `follows.id`, um `"id"` sem a tabela seria o da subconsulta (sempre falso).
    const shadowed = await withShadowIdColumn(t.database.db, 'follows', (tx) =>
      new FollowsRepository({ db: tx, close: () => Promise.resolve() }).searchCreators(
        viewer.id,
        'estudio',
        20,
        sql`true`,
      ),
    );
    expect(followedByHandle(shadowed)).toEqual(expected);
    // A transação foi desfeita: a tabela voltou a ser a das migrations.
    expect(await hasColumn(t.database.db, 'follows', 'id')).toBe(false);
  });
});

describe('GET /search/creators: rate limit (A-31)', () => {
  it('[A-31] 61ª busca no minuto pela mesma conta → 429 com Retry-After; outra conta segue', async () => {
    const { headers } = await reader();
    for (let index = 0; index < 60; index++) {
      await t.http.get('/v1/search/creators?q=abc').set(headers).expect(200);
    }
    const limited = await t.http.get('/v1/search/creators?q=abc').set(headers).expect(429);
    expect(ErrorResponseSchema.parse(limited.body).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await t.http
      .get('/v1/search/creators?q=abc')
      .set((await reader()).headers)
      .expect(200);
    t.clock.advance(60_000);
    await t.http.get('/v1/search/creators?q=abc').set(headers).expect(200);
  });
});
