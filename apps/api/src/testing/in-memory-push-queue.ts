import type { PushJobMessage } from '@sussurro/shared';

import { PushQueue } from '../infra/storage/push-queue.js';

/**
 * Fake da fila `push` do lado da API: guarda as mensagens enviadas. O consumo (lotes, recibos, 3
 * tentativas e DLQ) é testado no worker, com o fake de lá.
 */
export class InMemoryPushQueue extends PushQueue {
  readonly sent: PushJobMessage[] = [];
  /** Liga a falha em todas as chamadas (fila ou rede fora do ar). */
  down = false;

  send(messages: readonly PushJobMessage[]): Promise<void> {
    if (this.down) {
      return Promise.reject(new Error('fila push indisponível (simulado)'));
    }
    this.sent.push(...messages);
    return Promise.resolve();
  }

  clear(): void {
    this.sent.length = 0;
    this.down = false;
  }
}
