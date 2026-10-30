import { MediaJobMessageSchema } from '@sussurro/shared';

import type { MediaJobHandler } from './media-job.handler.js';
import { type ConsumerOptions, QueueConsumer, safeJson } from '../infra/queue-consumer.js';
import type { MessageQueue, QueueMessage } from '../infra/queue.js';

export type { ConsumerOptions } from '../infra/queue-consumer.js';

/**
 * Consumidor da fila `media-jobs` (ADR 0009): fotos de post, trocas de avatar e (Fase 5) o vídeo
 * dos reels. As mensagens que falham voltam depois do visibility timeout; depois de `maxAttempts`
 * entregas a fila as move para a DLQ (MID-10).
 */
export class MediaJobsConsumer extends QueueConsumer {
  constructor(
    queue: MessageQueue,
    private readonly handler: MediaJobHandler,
    options: ConsumerOptions,
  ) {
    super(queue, options, 'media-jobs');
  }

  protected async process(message: QueueMessage): Promise<boolean> {
    const parsed = MediaJobMessageSchema.safeParse(safeJson(message.body));
    if (!parsed.success) {
      // Nunca vai dar certo: fica para a DLQ, onde dá para inspecionar.
      this.logger.error(`Mensagem ${message.id} fora do formato de media-jobs`);
      return false;
    }
    const outcome = await this.handler.handle(parsed.data, {
      attempt: message.receiveCount,
      maxAttempts: this.options.maxAttempts,
    });
    return outcome === 'done';
  }
}
