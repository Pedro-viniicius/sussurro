import { randomUUID } from 'node:crypto';

import { MessageQueue, type QueueMessage } from '../infra/queue.js';

interface StoredMessage {
  id: string;
  body: string;
  receiveCount: number;
  visibleAt: number;
  receiptHandle: string | undefined;
  attributes: Record<string, string>;
}

export interface InMemoryQueueOptions {
  /** Visibility timeout (ms): mensagem recebida e não apagada volta depois disso. */
  visibilityTimeoutMs?: number;
  /** Redrive para a DLQ, como o `maxReceiveCount` do SQS/ElasticMQ. */
  maxReceiveCount?: number;
}

/**
 * Fake em memória da fila SQS com DLQ: visibility timeout, `ApproximateReceiveCount` e redrive
 * (na entrega seguinte à de número `maxReceiveCount`, a mensagem vai para a DLQ em vez de ser
 * entregue, como no SQS). O tempo é controlado pelo teste (`advance`).
 */
export class InMemoryQueue extends MessageQueue {
  private readonly messages: StoredMessage[] = [];
  readonly deadLetters: { id: string; body: string; receiveCount: number }[] = [];
  private nowMs = 0;
  private readonly visibilityTimeoutMs: number;
  private readonly maxReceiveCount: number;

  constructor(options: InMemoryQueueOptions = {}) {
    super();
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? 120_000;
    this.maxReceiveCount = options.maxReceiveCount ?? 3;
  }

  send(message: unknown, attributes: Record<string, string> = {}): string {
    const id = randomUUID();
    this.messages.push({
      id,
      body: typeof message === 'string' ? message : JSON.stringify(message),
      receiveCount: 0,
      visibleAt: this.nowMs,
      receiptHandle: undefined,
      attributes,
    });
    return id;
  }

  /** Avança o relógio da fila (ex.: além do visibility timeout). */
  advance(ms: number): void {
    this.nowMs += ms;
  }

  /** Mensagens ainda na fila principal (visíveis ou em voo). */
  get pending(): number {
    return this.messages.length;
  }

  receive(maxMessages: number): Promise<QueueMessage[]> {
    const delivered: QueueMessage[] = [];
    for (const message of [...this.messages]) {
      if (delivered.length >= maxMessages) {
        break;
      }
      if (message.visibleAt > this.nowMs) {
        continue;
      }
      if (message.receiveCount >= this.maxReceiveCount) {
        this.messages.splice(this.messages.indexOf(message), 1);
        this.deadLetters.push({
          id: message.id,
          body: message.body,
          receiveCount: message.receiveCount,
        });
        continue;
      }
      message.receiveCount += 1;
      message.visibleAt = this.nowMs + this.visibilityTimeoutMs;
      message.receiptHandle = randomUUID();
      delivered.push({
        id: message.id,
        receiptHandle: message.receiptHandle,
        body: message.body,
        receiveCount: message.receiveCount,
        attributes: message.attributes,
      });
    }
    return Promise.resolve(delivered);
  }

  delete(receiptHandle: string): Promise<void> {
    const index = this.messages.findIndex((message) => message.receiptHandle === receiptHandle);
    if (index >= 0) {
      this.messages.splice(index, 1);
    }
    return Promise.resolve();
  }
}
