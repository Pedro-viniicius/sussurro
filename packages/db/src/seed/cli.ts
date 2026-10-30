// `pnpm db:seed`: cria as personas do protótipo, as conexões, os follows e os posts (A-08) no banco
// do DATABASE_URL (lê o .env da raiz). `pnpm db:seed --volume` cria também o seed volumoso (FEED-16).
// Rode depois de `pnpm db:migrate`. Nunca em produção.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hash } from '@node-rs/argon2';

import { createDb } from '../client.ts';
import { PERSONAS, seedDatabase } from './seed.ts';
import { seedVolume, VOLUME_READER_HANDLE } from './volume.ts';

const rootEnv = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

if (process.env.NODE_ENV === 'production') {
  process.stderr.write('[seed] recusado: NODE_ENV=production.\n');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (url === undefined || url.trim() === '') {
  process.stderr.write('[seed] DATABASE_URL não definida (copie .env.example para .env).\n');
  process.exit(1);
}

/** Senha das personas. Precisa passar na política de senha (não está na lista de comuns). */
const customPassword = process.env.SEED_PASSWORD?.trim();
const password =
  customPassword === undefined || customPassword === '' ? 'sussurro-dev-2026' : customPassword;

// Mesmos parâmetros da API (OWASP: m=19 MiB, t=2, p=1). O algoritmo padrão é o argon2id.
const passwordHash = await hash(password, {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

const handle = createDb(url, { applicationName: 'sussurro-seed', max: 1 });
try {
  const now = new Date();
  const result = await seedDatabase(handle.db, { passwordHash, now });
  process.stdout.write(
    `[seed] criadas: ${result.created.join(', ') || 'nenhuma'}; já existiam: ${
      result.skipped.join(', ') || 'nenhuma'
    }; posts novos: ${String(result.posts)}; reels novos: ${String(result.reels)}; ` +
      `notificações novas: ${String(result.notifications)}\n`,
  );
  for (const persona of PERSONAS) {
    process.stdout.write(
      `  @${persona.handle} (${persona.accountType}) · ${persona.email} · senha: ${password}\n`,
    );
  }
  process.stdout.write(
    '[seed] conexões: helena–caio.r e helena–marinac; helena segue cozinhadabia e trilhasdosul.\n' +
      '[seed] busca (Fase 3): "estu" acha estudioaurora e estudiovinil (nunca a pessoa @estudante); ' +
      'trilhasdosul bloqueou estudante; helena denunciou estudiovinil.\n' +
      '[seed] conectar (Fase 4): lucasf e tomas não têm conexões (simulação em dev: ' +
      'POST /v1/dev/simulate-request); caio.r e marinac também não são conexão um do outro.\n' +
      '[seed] reels (Fase 5): marinac (só helena vê), trilhasdosul (2), cozinhadabia e helena.\n' +
      '[seed] notificações (Fase 6): curtidas, comentários, respostas e conexões entre as ' +
      'personas; cozinhadabia e trilhasdosul com "2 novas pessoas começaram a seguir você." ' +
      '(anônimo).\n' +
      '[seed] fotos e reels: os objetos do S3 vêm de `pnpm --filter @sussurro/worker seed:media` ' +
      '(compose no ar; o MP4 do seed é só de exemplo e não toca).\n',
  );

  // Modo volumoso (FEED-16): `pnpm db:seed --volume` ou SEED_VOLUME=1.
  if (process.argv.includes('--volume') || process.env.SEED_VOLUME === '1') {
    const started = Date.now();
    const volume = await seedVolume(handle.db, {
      passwordHash,
      now,
      onProgress: (message) => process.stdout.write(`[seed:volume] ${message}\n`),
    });
    process.stdout.write(
      volume.created
        ? `[seed:volume] pronto em ${String(Math.round((Date.now() - started) / 1000))} s: ` +
            `@${VOLUME_READER_HANDLE} (${VOLUME_READER_HANDLE}@example.com) com ` +
            `${String(volume.authors)} autores e ${String(volume.posts)} posts\n`
        : `[seed:volume] @${VOLUME_READER_HANDLE} já existe: nada a fazer\n`,
    );
  }
} finally {
  await handle.close();
}
