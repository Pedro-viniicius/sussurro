/**
 * Espera `operation` por no máximo `ms`. Usado nas dependências que podem falhar aberto (rate limit
 * e cache no Redis, R11): se o Redis demorar, a requisição segue sem ele.
 */
export async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`sem resposta em ${String(ms)} ms`));
    }, ms);
  });
  // Se o timeout vencer, a operação pode rejeitar depois: não deixar rejeição sem tratamento.
  operation.catch(() => undefined);
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
