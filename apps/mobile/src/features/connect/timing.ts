import { CONNECTION_POLL_INTERVAL_S } from '@sussurro/shared';

/**
 * Tempos da tela Conectar (ux.md §11.4 e §11.11). Objeto mutável só para os testes encurtarem as
 * esperas; o app usa os padrões. Os tempos do token vêm do servidor (`renewInS`), e os do encosto
 * (relato, aviso, QR em destaque, cartão) ficam no `touch-calibration.ts` (ADR 0012).
 */
export const connectTiming = {
  /** Polling da caixa de entrada (B) e do meu pedido (A), com a tela aberta. */
  pollMs: CONNECTION_POLL_INTERVAL_S * 1000,
  /** Relógio da contagem "Expira em 1:45". */
  tickMs: 1_000,
  /** Relógio do detector de encosto (a janela da mediana e o tempo sustentado). */
  touchTickMs: 200,
  /** "Não deu para confirmar" fica 6 s no lugar do texto do Pronto (estado 9). */
  notConfirmedNoticeMs: 6_000,
  /** O "Aproximando" só some depois de 2 s sem sinal (sem piscar). */
  approachingLeaveMs: 2_000,
  /** No Pronto, a tela fica acesa só nos primeiros 2 min sem encostar. */
  keepAwakeIdleMs: 120_000,
  /** Leitor de tela: "Quase lá" no máximo a cada 5 s (A1). */
  announceApproachingEveryMs: 5_000,
  /** O foco vai para o nome do cartão uns 300 ms depois de ele aparecer (ux.md §11.8). */
  focusDelayMs: 300,
  /**
   * O anúncio que acompanha uma mudança de foco sai esta folga depois do foco, em fila (ux.md §11.8):
   * dá tempo de o leitor começar a ler o elemento focado. A conferir no aparelho.
   */
  announceAfterFocusMs: 200,
  /**
   * O formulário de denúncia por cima do cartão (ux.md §11.14): no iOS, o que vem depois de fechar
   * (o foco, o Toast, a volta ao Pronto) espera o `onDismiss` do `Modal`. Se ele não vier até aqui,
   * segue mesmo assim, para o cartão nunca ficar preso.
   */
  formDismissFallbackMs: 1_000,
  /**
   * A câmera do QR que fecha porque o cartão chegou (ux.md §11.15): no iOS, o foco e o anúncio do
   * cartão esperam o `onDismiss` do `Modal`. Se ele não vier até aqui, seguem mesmo assim.
   */
  cameraDismissFallbackMs: 1_000,
  /**
   * "Bloquear" confirmado a menos disto do fim do cartão (11, 14) é recusado como o M7 (ADR 0012,
   * R1-11; BAIXO 6): o pedido chegaria com o par já vencido, e o servidor responderia o 204 de
   * sempre sem gravar ("Você bloqueou" sem ter bloqueado).
   */
  blockConfirmMarginMs: 3_000,
  /**
   * A renovação dos tokens com falha repetível (sem rede, 5xx) tenta de novo a cada 3 s, até 3 vezes,
   * antes de parar a tela (ADR 0012, A3-3 item 4). As três cabem nos 10 s entre a renovação (20 s)
   * e o fim da validade (30 s).
   */
  tokenRetryMs: 3_000,
  tokenRetries: 3,
  /**
   * Teto das emissões de tokens (PROX-68): o servidor aceita 6 por minuto por conta (o limite
   * `prox-tokens:user` da API, PROX-20) e responde 429 acima disso, que a tela mostra como "Muitas
   * tentativas" (20). O app conta as próprias emissões numa janela móvel de 60 s, e a tentativa de
   * novo que passaria do teto não sai. A renovação normal (3 por minuto) nunca chega a ele.
   */
  tokenIssueLimit: 6,
  tokenIssueWindowMs: 60_000,
  /** O Spinner do "Verificando" só aparece depois de 300 ms. */
  checkingSpinnerMs: 300,
  /** Deep link do QR sem sessão: o token é descartado depois de 30 s (4.7 CA6). */
  pendingLinkTtlMs: 30_000,
};

/** Relógio trocável nos testes (e fora do render, para as regras de pureza do React). */
export const connectClock = {
  now: (): number => Date.now(),
};
