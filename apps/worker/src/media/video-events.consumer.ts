import type { VideoEventsHandler } from './video-events.handler.js';
import { type ConsumerOptions, QueueConsumer, safeJson } from '../infra/queue-consumer.js';
import type { MessageQueue, QueueMessage } from '../infra/queue.js';

/**
 * Consumidor da fila `video-events` (Fase 5, ADR 0006): o EventBridge entrega ali o "MediaConvert
 * Job State Change" (`COMPLETE`/`ERROR`) dos jobs com `userMetadata.app = sussurro`. Só roda com
 * `VIDEO_PROCESSOR=mediaconvert`. Corpo que nem é JSON fica para a DLQ (para inspecionar); evento
 * que não é deste app é apagado sem efeito.
 */
export class VideoEventsConsumer extends QueueConsumer {
  constructor(
    queue: MessageQueue,
    private readonly handler: VideoEventsHandler,
    options: ConsumerOptions,
  ) {
    super(queue, options, 'video-events');
  }

  protected async process(message: QueueMessage): Promise<boolean> {
    const event = safeJson(message.body);
    if (event === undefined) {
      this.logger.error(`Mensagem ${message.id} da video-events não é JSON`);
      return false;
    }
    return (await this.handler.handle(event)) === 'done';
  }
}
