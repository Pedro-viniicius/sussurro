import type { createDb } from '@sussurro/db';
import { describe, expect, it, vi } from 'vitest';

import {
  type MigrationLogLevel,
  type MigrationTaskDeps,
  redactDatabaseUrl,
  runMigrationTask,
} from './migrate.js';

const URL_WITH_PASSWORD = 'postgres://sussurro_migrator:s3nh4-s3cr3t4@db.interno:5432/sussurro';

function fakeDeps(run: () => Promise<void>) {
  const close = vi.fn().mockResolvedValue(undefined);
  const lines: { level: MigrationLogLevel; message: string }[] = [];
  const deps: MigrationTaskDeps = {
    createDb: vi.fn(() => ({ db: {}, pool: {}, close })) as unknown as typeof createDb,
    runMigrations: vi.fn(run),
    log: (level, message) => {
      lines.push({ level, message });
    },
  };
  return { deps, close, lines };
}

describe('runMigrationTask (task de migration do deploy, 7.6 e 7.7)', () => {
  it('7.7: aplica as migrations com uma conexão só e sai com 0', async () => {
    const { deps, close, lines } = fakeDeps(() => Promise.resolve());

    await expect(runMigrationTask({ DATABASE_URL: URL_WITH_PASSWORD }, deps)).resolves.toBe(0);

    expect(deps.createDb).toHaveBeenCalledWith(URL_WITH_PASSWORD, {
      max: 1,
      connectionTimeoutMillis: 10_000,
      applicationName: 'sussurro-migrate',
    });
    expect(deps.runMigrations).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)?.level).toBe('info');
  });

  it('7.7: falha da migration sai com 1, fecha a conexão e não escreve a senha no log', async () => {
    const { deps, close, lines } = fakeDeps(() =>
      Promise.reject(
        new Error(`relation "users" already exists (conexão ${URL_WITH_PASSWORD})`, {
          cause: new Error('s3nh4-s3cr3t4'),
        }),
      ),
    );

    await expect(runMigrationTask({ DATABASE_URL: URL_WITH_PASSWORD }, deps)).resolves.toBe(1);

    expect(close).toHaveBeenCalledTimes(1);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('relation "users" already exists');
    expect(lines.map((line) => line.message).join('\n')).not.toContain('s3nh4-s3cr3t4');
  });

  it('7.7: sem DATABASE_URL sai com 1 sem tentar conectar', async () => {
    const { deps, lines } = fakeDeps(() => Promise.resolve());

    await expect(runMigrationTask({ DATABASE_URL: '  ' }, deps)).resolves.toBe(1);

    expect(deps.createDb).not.toHaveBeenCalled();
    expect(lines[0]?.message).toContain('DATABASE_URL obrigatória');
  });

  it('7.7: URL inválida sai com 1 sem expor o valor', async () => {
    const { deps, lines } = fakeDeps(() => Promise.resolve());
    deps.createDb = vi.fn(() => {
      throw new Error('DATABASE_URL inválida: sem nome do banco');
    });

    await expect(
      runMigrationTask({ DATABASE_URL: 'postgres://u:outra-senha@host:5432' }, deps),
    ).resolves.toBe(1);

    expect(deps.runMigrations).not.toHaveBeenCalled();
    expect(lines.map((line) => line.message).join('\n')).not.toContain('outra-senha');
  });
});

describe('redactDatabaseUrl', () => {
  it('tira a URL inteira e a senha codificada e decodificada', () => {
    const url = 'postgres://app:p%40ss%2Fword@host:5432/db';

    const out = redactDatabaseUrl(`falhou em ${url}; senha p@ss/word; bruta p%40ss%2Fword`, url);

    expect(out).toBe('falhou em [DATABASE_URL]; senha ***; bruta ***');
  });

  it('URL sem senha ou inválida não muda o texto além da própria URL', () => {
    expect(redactDatabaseUrl('nada a esconder', 'postgres://app@host/db')).toBe('nada a esconder');
    expect(redactDatabaseUrl('texto', 'não é url')).toBe('texto');
  });
});
