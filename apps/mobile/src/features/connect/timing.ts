import { CONNECTION_POLL_INTERVAL_S } from '@sussurro/shared';

/**
 * Tempos da tela Conectar (ux.md §11.4 e ADR 0013 §5). Objeto mutável só para os testes encurtarem
 * as esperas; o app usa os padrões. Os tempos do token vêm do servidor (`renewInS`).
 */
export const connectTiming = {
  /** Polling da caixa de entrada (B) e do meu pedido (A), com a tela aberta. */
  pollMs: CONNECTION_POLL_INTERVAL_S * 1000,
  /** Relógio da contagem "Expira em 1:45". */
  tickMs: 1_000,
  /** O foco vai para o nome do cartão uns 300 ms depois de ele aparecer (ux.md §11.8). */
  focusDelayMs: 300,
  /**
   * O anúncio que acompanha uma mudança de foco sai esta folga depois do foco, em fila (ux.md §11.8):
   * dá tempo de o leitor começar a ler o elemento focado. A conferir no aparelho.
   */
  announceAfterFocusMs: 200,
  /**
   * A renovação do token com falha repetível (sem rede, 5xx) tenta de novo a cada 3 s, até 3 vezes,
   * antes de parar a tela. As três cabem nos 10 s entre a renovação (20 s) e o fim da validade (30 s).
   */
  tokenRetryMs: 3_000,
  tokenRetries: 3,
  /**
   * Teto das emissões de tokens (PROX-68): o servidor aceita 6 por minuto por conta (o limite
   * `prox-tokens:user` da API, PROX-20) e responde 429 acima disso, que a tela mostra como "Muitas
   * tentativas". O app conta as próprias emissões numa janela móvel de 60 s, e a tentativa de novo
   * que passaria do teto não sai. A renovação normal (3 por minuto) nunca chega a ele.
   */
  tokenIssueLimit: 6,
  tokenIssueWindowMs: 60_000,
  /** Deep link do código sem sessão: o token é descartado depois de 30 s (4.7 CA6). */
  pendingLinkTtlMs: 30_000,
};

/** Relógio trocável nos testes (e fora do render, para as regras de pureza do React). */
export const connectClock = {
  now: (): number => Date.now(),
};
