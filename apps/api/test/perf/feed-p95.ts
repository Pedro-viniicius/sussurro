// FEED-16 (testes.md §5.2): mede o tempo do GET /v1/feed contra uma API no ar, com o seed volumoso
// (`pnpm db:seed --volume`: 1 leitor, 150 conexões, 500 criadores, 100 mil posts). Mede a primeira
// página e as seguintes (cursor) das abas de foto e texto e imprime p50, p95 e máximo. A meta da
// arquitetura é p95 < 300 ms no servidor; aqui o tempo inclui o HTTP local.
//
// Uso: node test/perf/feed-p95.ts [URL da API] [rodadas]
//      (padrão http://127.0.0.1:3000 e 50 rodadas; a senha vem de SEED_PASSWORD ou o padrão do seed)
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3000';
const rounds = Number(process.argv[3] ?? '50');
const password = process.env.SEED_PASSWORD ?? 'sussurro-dev-2026';

interface FeedPage {
  items: unknown[];
  nextCursor: string | null;
}

async function login(): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'leitor.volume@example.com', password }),
  });
  if (!response.ok) {
    throw new Error(`login falhou (${String(response.status)}): rode pnpm db:seed --volume antes`);
  }
  const body = (await response.json()) as { tokens: { accessToken: string } };
  return body.tokens.accessToken;
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

async function timedPage(token: string, query: string): Promise<{ ms: number; page: FeedPage }> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/feed?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const page = (await response.json()) as FeedPage;
  const ms = performance.now() - started;
  if (!response.ok) {
    throw new Error(`feed respondeu ${String(response.status)}`);
  }
  return { ms, page };
}

const token = await login();
const samples: number[] = [];
let items = 0;
// Aquecimento: primeira consulta paga o plano e o cache.
await timedPage(token, 'type=photo&limit=20');
for (let round = 0; round < rounds; round++) {
  for (const type of ['photo', 'text']) {
    let cursor: string | null = null;
    // Primeira página e mais duas seguindo o cursor (como quem rola o feed).
    for (let page = 0; page < 3; page++) {
      const query: string =
        cursor === null
          ? `type=${type}&limit=20`
          : `type=${type}&limit=20&cursor=${encodeURIComponent(cursor)}`;
      const result = await timedPage(token, query);
      samples.push(result.ms);
      items += result.page.items.length;
      cursor = result.page.nextCursor;
      if (cursor === null) {
        break;
      }
    }
  }
}
samples.sort((a, b) => a - b);
process.stdout.write(
  `[FEED-16] ${String(samples.length)} chamadas, ${String(items)} itens: ` +
    `p50 ${percentile(samples, 0.5).toFixed(1)} ms · p95 ${percentile(samples, 0.95).toFixed(1)} ms · ` +
    `máx ${(samples.at(-1) ?? 0).toFixed(1)} ms\n`,
);
