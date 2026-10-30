import { PushJobMessageSchema } from '@sussurro/shared';

import type { PushJob, PushJobHandler } from './push-job.handler.js';
import { type ConsumerOptions, QueueConsumer, safeJson } from '../infra/queue-consumer.js';
import type { MessageQueue, QueueMessage } from '../infra/queue.js';

/**
 * Consumidor da fila `push` (ADR 0011): a rodada inteira (até 10 mensagens do SQS) vai ao Expo num
 * lote. Mensagem fora do formato fica para a DLQ; a que falhou no Expo volta depois do visibility
 * timeout e, depois de `maxAttempts` entregas, a fila a move para a `push-dlq` (6.5 CA4).
 */
export class PushConsumer extends QueueConsumer {
  constructor(
    queue: MessageQueue,
    private readonly handler: PushJobHandler,
    options: ConsumerOptions,
  ) {
    super(queue, options, 'push');
  }

  /** Não usado: a `push` processa a rodada inteira em `handleReceived`. */
  protected process(): Promise<boolean> {
    return Promise.resolve(false);
  }

  protected override async handleReceived(messages: QueueMessage[]): Promise<void> {
    const jobs: PushJob[] = [];
    for (const message of messages) {
      const parsed = PushJobMessageSchema.safeParse(safeJson(message.body));
      if (!parsed.success) {
        // Nunca vai dar certo: fica para a DLQ, onde dá para inspecionar.
        this.logger.error(`Mensagem ${message.id} fora do formato de push`);
        continue;
      }
      const traceparent = message.attributes?.traceparent;
      jobs.push({
        key: message.id,
        job: parsed.data,
        ...(traceparent === undefined ? {} : { trace: { traceparent } }),
      });
    }
    if (jobs.length === 0) {
      return;
    }
    let outcomes;
    try {
      outcomes = await this.handler.handleBatch(jobs);
    } catch (error) {
      // Banco fora, por exemplo: todas voltam depois do visibility timeout.
      for (const message of messages) {
        this.reportFailure(message, error);
      }
      return;
    }
    const byId = new Map(messages.map((message) => [message.id, message]));
    for (const job of jobs) {
      const message = byId.get(job.key);
      if (message === undefined) {
        continue;
      }
      if (outcomes.get(job.key) === 'done') {
        await this.ack(message);
      } else if (message.receiveCount >= this.options.maxAttempts) {
        // Última tentativa: a próxima entrega leva a mensagem para a DLQ.
        this.logger.error(
          `Push ${message.id} falhou ${String(message.receiveCount)} vezes: vai para a DLQ`,
        );
      }
    }
  }
}
