// Integração do cliente node-postgres: precisa de um servidor Postgres (compose ou CI).
// Pulado com TEST_DB=pglite: o PGlite roda em processo e não passa pelo pool do `pg`.
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { createDb } from './client.ts';
import { isPgliteMode } from './testing/index.ts';

describe.skipIf(isPgliteMode())('createDb (integração, só Postgres de servidor)', () => {
  const url = process.env.DATABASE_URL ?? '';
  const handle = isPgliteMode()
    ? undefined
    : createDb(url, { applicationName: 'sussurro-db-int-test' });

  afterAll(async () => {
    await handle?.close();
  });

  it('conecta e roda select 1', async () => {
    const result = await handle!.db.execute<{ ok: number }>(sql`select 1 as ok`);
    expect(result.rows[0]?.ok).toBe(1);
  });

  it('o servidor é PostgreSQL 18', async () => {
    const result = await handle!.db.execute<{ server_version_num: string }>(
      sql`show server_version_num`,
    );
    expect(Number(result.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180000);
  });
});
