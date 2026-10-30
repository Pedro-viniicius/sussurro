import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { PushJobMessage } from '@sussurro/shared';

import type { Tracing } from '../observability/tracing.js';

/**
 * Porta da fila `push` do lado da API (ADR 0011): só envia, depois do commit. SQS em produção,
 * ElasticMQ em dev, fake em memória nos testes. As mensagens levam só ids (`PushJobMessage`).
 */
export abstract class PushQueue {
  abstract send(messages: readonly PushJobMessage[]): Promise<void>;
}

/**
 * SQS de verdade (ou ElasticMQ pelo `AWS_ENDPOINT_URL_SQS`). Com o OpenTelemetry ligado, o
 * `traceparent` vai nos atributos da mensagem (infra.md §5); desligado, nenhum atributo.
 */
export class SqsPushQueue extends PushQueue {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly client: Pick<SQSClient, 'send'>,
    private readonly queueName: string,
    private readonly tracing: Pick<Tracing, 'inject'>,
  ) {
    super();
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.client
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
      .then((result) => {
        if (result.QueueUrl === undefined) {
          throw new Error(`Fila ${this.queueName} sem URL`);
        }
        return result.QueueUrl;
      })
      .catch((error: unknown) => {
        // Não guarda a falha: a próxima chamada tenta de novo.
        this.queueUrl = undefined;
        throw error;
      });
    return this.queueUrl;
  }

  async send(messages: readonly PushJobMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const queueUrl = await this.resolveQueueUrl();
    const attributes = Object.fromEntries(
      Object.entries(this.tracing.inject({})).map(([name, value]) => [
        name,
        { DataType: 'String', StringValue: value },
      ]),
    );
    // SendMessageBatch aceita até 10 mensagens.
    for (let start = 0; start < messages.length; start += 10) {
      const batch = messages.slice(start, start + 10);
      const result = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message),
            ...(Object.keys(attributes).length === 0 ? {} : { MessageAttributes: attributes }),
          })),
        }),
      );
      if (result.Failed !== undefined && result.Failed.length > 0) {
        throw new Error(
          `SQS recusou ${String(result.Failed.length)} mensagem(ns) de push: ${result.Failed.map((item) => item.Code).join(', ')}`,
        );
      }
    }
  }
}
