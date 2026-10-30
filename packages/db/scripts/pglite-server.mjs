// Servidor Postgres de DESENVOLVIMENTO sem Docker: PGlite (Postgres 18 em WebAssembly) exposto no
// protocolo do Postgres por @electric-sql/pglite-socket. Serve para subir a API de verdade e rodar
// `pnpm db:migrate` / `pnpm db:seed` quando o compose não está disponível (máquina sem WSL2).
// Não substitui o compose: é um processo só, com as conexões multiplexadas numa sessão do PGlite.
//
// Uso: pnpm --filter @sussurro/db db:pglite   (porta 5433; dados em memória, somem ao sair)
//      PGLITE_PORT=5434 PGLITE_DATA_DIR=./.pglite pnpm --filter @sussurro/db db:pglite
// Depois: DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.PGLITE_PORT ?? '5433');
const dataDir = process.env.PGLITE_DATA_DIR;

const db = dataDir === undefined || dataDir === '' ? new PGlite() : new PGlite(dataDir);
await db.waitReady;
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
await server.start();
process.stdout.write(
  `[pglite] Postgres de desenvolvimento em 127.0.0.1:${String(port)} ` +
    `(${dataDir ? `dados em ${dataDir}` : 'em memória'}).\n` +
    `[pglite] DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${String(port)}/postgres\n`,
);

const shutdown = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
