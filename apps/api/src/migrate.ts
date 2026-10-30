// Task de migration do deploy (infra.md §6.6, docs/deploy/runbook.md): `node dist/migrate.js`, com a
// mesma imagem da API e o usuário sussurro_migrator. Aplica as migrations pendentes do packages/db
// (a mesma tabela de controle do `pnpm db:migrate`) e sai com 0; qualquer falha sai com 1, e o
// deploy para antes de trocar a revisão dos serviços. A DATABASE_URL (que tem a senha) nunca vai
// para o log.
import { createDb, runMigrations } from '@sussurro/db';

import { describeError } from './common/errors/describe-error.js';
import { loadRootEnvFile } from './config/env-file.js';

export type MigrationLogLevel = 'info' | 'error';

export interface MigrationTaskDeps {
  createDb: typeof createDb;
  runMigrations: typeof runMigrations;
  log: (level: MigrationLogLevel, message: string) => void;
}

/** Uma linha JSON por evento, como o resto dos logs no CloudWatch. */
function writeLine(level: MigrationLogLevel, message: string): void {
  const line = `${JSON.stringify({ level, time: new Date().toISOString(), msg: message })}\n`;
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

const defaultDeps: MigrationTaskDeps = { createDb, runMigrations, log: writeLine };

/** Tira a URL e a senha (como veio e decodificada) de qualquer texto que vá para o log. */
export function redactDatabaseUrl(text: string, url: string): string {
  let out = text.split(url).join('[DATABASE_URL]');
  let password: string;
  try {
    password = new URL(url).password;
  } catch {
    return out;
  }
  if (password === '') {
    return out;
  }
  out = out.split(password).join('***');
  try {
    const decoded = decodeURIComponent(password);
    if (decoded !== password) {
      out = out.split(decoded).join('***');
    }
  } catch {
    // Senha com "%" solto: a forma codificada já saiu acima.
  }
  return out;
}

/** Aplica as migrations e devolve o código de saída do processo (0 = ok). */
export async function runMigrationTask(
  env: Record<string, string | undefined>,
  deps: MigrationTaskDeps = defaultDeps,
): Promise<number> {
  const url = env.DATABASE_URL?.trim() ?? '';
  if (url === '') {
    deps.log('error', 'DATABASE_URL obrigatória (postgres://usuario:senha@host:5432/banco)');
    return 1;
  }

  let handle: ReturnType<typeof createDb>;
  try {
    handle = deps.createDb(url, {
      max: 1,
      connectionTimeoutMillis: 10_000,
      applicationName: 'sussurro-migrate',
    });
  } catch (error) {
    deps.log('error', `migrations não aplicadas: ${redactDatabaseUrl(describeError(error), url)}`);
    return 1;
  }

  const startedAt = Date.now();
  try {
    deps.log('info', 'aplicando as migrations pendentes');
    await deps.runMigrations(handle.db);
    deps.log('info', `migrations aplicadas em ${String(Date.now() - startedAt)} ms`);
    return 0;
  } catch (error) {
    deps.log('error', `migrations não aplicadas: ${redactDatabaseUrl(describeError(error), url)}`);
    return 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

if (import.meta.main) {
  loadRootEnvFile();
  process.exitCode = await runMigrationTask(process.env);
}
