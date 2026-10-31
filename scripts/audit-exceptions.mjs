// Exceções do `pnpm audit` (infra.md §8.3). Uso: node scripts/audit-exceptions.mjs
// Roda no job "quality" (todo PR; bloqueia o merge) e no job "audit" do CI.
//
// O pnpm ignora uma GHSA inteira (pnpm-workspace.yaml → audit.ignore), em qualquer caminho e sem
// prazo. Este script estreita cada exceção: a GHSA ignorada precisa estar registrada abaixo, com o
// pacote, a primeira versão corrigida, os únicos pacotes que podem trazer uma versão vulnerável e a
// data de revisão. Falha fechado, saindo com 1, quando:
// - qualquer GHSA aparece nos arquivos de configuração do pnpm (em qualquer lugar e grafia, mesmo
//   num comentário) sem registro aqui, ou um registro não tem a GHSA no pnpm-workspace.yaml;
// - a data de revisão passou;
// - uma versão vulnerável chega por um pacote fora da lista, ou sem pacote conhecido
//   (`pnpm why <pacote> --prod --json`, que lê só o lockfile); a pré-versão da versão corrigida e
//   a versão não numérica (`link:`, `file:`, git) contam como vulneráveis;
// - não sobrou versão vulnerável (a exceção não serve mais e precisa sair).
// Mudar esta lista ou o audit.ignore exige o aval do `seguranca`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXCEPTIONS = [
  {
    // zod: estouro de memória na validação de arrays grandes (alta, só disponibilidade). Vem só pelo
    // @expo/cli 58.1.17 (CLI de desenvolvimento do Expo; não entra no app nem nas imagens). Não há
    // 3.x corrigido; o @expo/cli 58.1.18 (expo 58.0.22, de 2026-10-31) não depende mais do zod.
    ghsa: 'GHSA-mrhx-c7xc-m3w5',
    pkg: 'zod',
    fixedIn: '4.6.6',
    allowedParents: ['@expo/cli'],
    reviewBy: '2026-11-30',
  },
];

/** Onde o pnpm lê configuração (as exceções só podem estar no pnpm-workspace.yaml). */
const CONFIG_FILES = ['pnpm-workspace.yaml', 'package.json', '.npmrc'];

const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/gi;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Mesma GHSA em qualquer grafia: `GHSA-` em maiúsculas e o resto em minúsculas. */
export const canonical = (ghsa) => `GHSA-${ghsa.slice(5).toLowerCase()}`;

/** As GHSAs citadas num texto, em qualquer lugar e grafia (sem âncoras: falha fechado). */
export const ghsasIn = (text) => [...text.matchAll(GHSA)].map((match) => canonical(match[0]));

/**
 * A versão é vulnerável (anterior à corrigida, `fixedIn` no formato x.y.z)? Na dúvida, sim: a
 * pré-versão da mesma x.y.z (`4.6.6-beta.1` vem antes da `4.6.6`) e o que não for semver
 * (`link:`, `file:`, git) contam.
 */
export function isVulnerable(version, fixedIn) {
  const fixed = SEMVER.exec(fixedIn);
  if (fixed === null || fixed[4] !== undefined) {
    throw new Error(`fixedIn "${fixedIn}" precisa ser uma versão x.y.z`);
  }
  const v = SEMVER.exec(String(version));
  if (v === null) {
    return true;
  }
  for (let i = 1; i <= 3; i += 1) {
    const a = Number(v[i]);
    const b = Number(fixed[i]);
    if (a !== b) {
      return a < b;
    }
  }
  return v[4] !== undefined;
}

/** `pnpm why <pacote> --prod --json` (lê o lockfile; não precisa do node_modules). */
function pnpmWhy(pkg) {
  const args = ['why', pkg, '--prod', '--json'];
  const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  // No Windows o pnpm é um .cmd, que só roda por um shell (os argumentos são fixos, deste arquivo).
  return process.platform === 'win32'
    ? spawnSync(['pnpm', ...args].join(' '), { ...options, shell: true })
    : spawnSync('pnpm', args, options);
}

/** Confere uma exceção. Devolve os erros; sem erro, escreve o resumo. */
function checkException(exception, found, today) {
  const { pkg, fixedIn, allowedParents, reviewBy } = exception;
  const ghsa = canonical(exception.ghsa);
  const errors = [];
  if (!(found.get(ghsa) ?? []).includes('pnpm-workspace.yaml')) {
    return [`${ghsa} está registrada aqui, mas não no pnpm-workspace.yaml: apague o registro`];
  }
  if (!SEMVER.test(fixedIn) || fixedIn.includes('-')) {
    return [`${ghsa}: fixedIn "${fixedIn}" precisa ser uma versão x.y.z`];
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewBy) || today > reviewBy) {
    errors.push(`${ghsa} (${pkg}): a data de revisão (${reviewBy}) passou ou é inválida`);
  }

  const why = pnpmWhy(pkg);
  if (why.status !== 0) {
    return [
      ...errors,
      `pnpm why ${pkg} falhou (código ${String(why.status)}): ${why.stderr.trim()}`,
    ];
  }

  let vulnerable = 0;
  for (const entry of JSON.parse(why.stdout)) {
    if (!isVulnerable(entry.version, fixedIn)) {
      continue;
    }
    vulnerable += 1;
    const label = `${pkg}@${String(entry.version)} (${ghsa})`;
    const parents = entry.dependents ?? [];
    if (parents.length === 0) {
      errors.push(`${label} sem pacote conhecido que o traga`);
    }
    for (const parent of parents) {
      if (!allowedParents.includes(parent.name)) {
        errors.push(
          `${label} chega por ${parent.name}@${parent.version}, fora da exceção (${allowedParents.join(', ')})`,
        );
      }
    }
  }
  if (vulnerable === 0) {
    errors.push(
      `${ghsa}: nenhuma versão vulnerável de ${pkg} (< ${fixedIn}) no lockfile; tire a GHSA do audit.ignore e apague o registro`,
    );
  }
  if (errors.length === 0) {
    console.log(
      `${ghsa}: ${pkg} < ${fixedIn} em ${String(vulnerable)} versão(ões), só por ${allowedParents.join(', ')}; revisar até ${reviewBy}`,
    );
  }
  return errors;
}

function main() {
  const errors = [];

  /** GHSA → arquivos em que aparece. */
  const found = new Map();
  for (const file of CONFIG_FILES) {
    let text;
    try {
      text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    } catch {
      continue;
    }
    for (const ghsa of ghsasIn(text)) {
      found.set(ghsa, [...new Set([...(found.get(ghsa) ?? []), file])]);
    }
  }

  const registered = new Set(EXCEPTIONS.map((exception) => canonical(exception.ghsa)));
  for (const [ghsa, files] of found) {
    if (!registered.has(ghsa)) {
      errors.push(`${ghsa} aparece em ${files.join(', ')} sem registro neste script`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const exception of EXCEPTIONS) {
    errors.push(...checkException(exception, found, today));
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`audit-exceptions: ${error}`);
    }
    console.error('Veja docs/equipe/infra.md §8.3.');
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
