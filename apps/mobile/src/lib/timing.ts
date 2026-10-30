/**
 * Intervalos do app (mídia em processamento, busca). Objeto mutável só para os testes encurtarem a
 * espera; o app usa os padrões.
 */
export const timing = {
  /** Primeira espera ao consultar um post ou avatar em `processing` (cresce até 5 s). */
  pollIntervalMs: 1_500,
  /** Pausa na digitação antes de chamar a busca de criadores (rate limit de 60/min, A-31). */
  searchDebounceMs: 300,
  /**
   * Pausa antes do pedido contextual de notificações (6.4 CA1): o modal do Criar termina de fechar
   * e o "Publicado." ou o "Vocês estão conectados" aparece antes da pergunta.
   */
  pushPromptDelayMs: 800,
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
