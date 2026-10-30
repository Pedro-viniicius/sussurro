import { createDb, eq, users } from '@sussurro/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerShutdownSignals } from './shutdown.js';

/**
 * PERM-17: o app falha ao fechar por causa de uma consulta (o `DrizzleQueryError` traz os valores).
 * O log do desligamento leva o SQL, o SQLSTATE e os frames, nunca os valores. Valores fictícios.
 */
const VALUES = {
  email: 'ana.souza+desligamento@mail.exemplo.com.br',
  hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsLWRlc2xpZ2FtZW50bw$aGFzaC1kZXNsaWdhbWVudG8', // gitleaks:allow
  name: 'Ana Souza Fictícia',
  bio: 'minha bio\n    at frameFalsoDaBio (bio.js:1:1)',
};
const USER_ID = '01a189e0-af57-7000-85fe-2054e618fea6';

function leaks(text: string): string[] {
  return Object.entries({
    ...VALUES,
    emailLocal: 'ana.souza+desligamento',
    salt: 'c2FsLWRlc2xpZ2FtZW50bw',
    bio: 'frameFalsoDaBio',
    params: 'params:',
  })
    .filter(([, value]) => text.includes(value))
    .map(([key]) => key);
}

/** Um `DrizzleQueryError` de verdade (drizzle-orm do `@sussurro/db`, pool do `pg` falhando). */
async function realQueryError(): Promise<Error> {
  const handle = createDb('postgres://usuario@127.0.0.1:5432/sussurro_teste');
  vi.spyOn(handle.pool, 'query').mockRejectedValue(
    Object.assign(new Error('terminating connection due to administrator command'), {
      name: 'error',
      code: '57P01',
      detail: `Key (email)=(${VALUES.email})`,
    }),
  );
  try {
    await handle.db
      .update(users)
      .set({ email: VALUES.email, passwordHash: VALUES.hash, name: VALUES.name, bio: VALUES.bio })
      .where(eq(users.id, USER_ID));
  } catch (error) {
    return error as Error;
  } finally {
    await handle.close();
  }
  throw new Error('a consulta deveria ter falhado');
}

afterEach(() => {
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  vi.restoreAllMocks();
});

describe('registerShutdownSignals com o banco falhando ao fechar (PERM-17)', () => {
  it('[PERM-17] o log tem o SQL, o SQLSTATE e os frames, sem os valores; sai com 1', async () => {
    const error = await realQueryError();
    expect(leaks(`${error.message}\n${error.stack ?? ''}`)).toEqual(
      expect.arrayContaining(['email', 'hash', 'name']),
    );
    const app = { close: vi.fn().mockRejectedValue(error) };
    const logger = { log: vi.fn(), error: vi.fn() };
    const exit = vi.fn();
    registerShutdownSignals(app, logger, exit);

    process.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const text = String(logger.error.mock.calls[0]?.[0]);
    const [first, ...frames] = text.split('\n');
    expect(first).toMatch(
      /^Failed query: update "users" set .* <- terminating connection due to administrator command \[57P01\]$/,
    );
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((line) => /^\s+at\s/.test(line))).toBe(true);
    expect(leaks(text)).toEqual([]);
  });
});
