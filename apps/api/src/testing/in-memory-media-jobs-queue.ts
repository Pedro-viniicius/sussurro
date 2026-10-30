import type { MediaJobMessage } from '@sussurro/shared';

import { MediaJobsQueue } from '../infra/storage/media-jobs-queue.js';

/**
 * Fake da fila `media-jobs` do lado da API: guarda as mensagens enviadas. O consumo (visibilidade,
 * 3 tentativas e DLQ) é testado no worker, com o fake de lá e com o ElasticMQ.
 */
export class InMemoryMediaJobsQueue extends MediaJobsQueue {
  readonly sent: MediaJobMessage[] = [];
  /** Liga uma falha na próxima chamada (teste do "fila fora do ar"). */
  failNext = false;

  send(messages: readonly MediaJobMessage[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fila indisponível (simulado)'));
    }
    this.sent.push(...messages);
    return Promise.resolve();
  }

  clear(): void {
    this.sent.length = 0;
    this.failNext = false;
  }
}
