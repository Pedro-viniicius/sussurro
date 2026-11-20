import { type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { qualified } from './qualified.ts';
import { follows, users } from './schema/index.ts';

// Só monta o SQL (`toSQL`), sem conexão.
const db = drizzle.mock();

/** O `followedByMe` do `searchCreators`, com a coluna de fora escrita por `column`. */
function followedBy(column: SQL | typeof users.id): string {
  return db
    .select({
      id: users.id,
      followedByMe: sql<boolean>`exists (
        select 1 from ${follows} f where f.creator_id = ${column})`,
    })
    .from(users)
    .toSQL().sql;
}

describe('qualified (R25; BUS-10 e PROX-05)', () => {
  it('[BUS-10] [PROX-05] (R25) escreve a coluna com a tabela dentro de sql na lista de um select sem join', () => {
    expect(followedBy(qualified(users.id))).toContain('f.creator_id = "users"."id"');
  });

  it('[BUS-10] [PROX-05] (R25, premissa) sem o helper, o Drizzle escreve a coluna sem a tabela nessa lista', () => {
    // Se este teste falhar depois de atualizar o Drizzle, a premissa do R25 mudou: rever o helper
    // e o texto do risco em arquitetura.md §16.
    expect(followedBy(users.id)).toContain('f.creator_id = "id")');
  });

  it('[BUS-10] [PROX-05] (R25) com uma tabela de alias(), sai o alias', () => {
    const author = alias(users, 'author');
    const { sql: text } = db
      .select({ authorId: sql<string>`${qualified(author.id)}` })
      .from(author)
      .toSQL();
    expect(text).toBe('select "author"."id" from "users" "author"');
  });

  it('[BUS-10] [PROX-05] (R25) sai o nome da coluna no banco, não o da propriedade', () => {
    const { sql: text } = db
      .select({ key: sql<string | null>`${qualified(users.avatarKey)}` })
      .from(users)
      .toSQL();
    expect(text).toBe('select "users"."avatar_key" from "users"');
  });
});
