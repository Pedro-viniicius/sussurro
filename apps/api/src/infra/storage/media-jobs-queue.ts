import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import type { MediaJobMessage } from '@sussurro/shared';

/**
 * Porta da fila `media-jobs` do lado da API: só envia (ADR 0009). SQS em produção, ElasticMQ em
 * dev, fake em memória nos testes.
 */
export abstract class MediaJobsQueue {
  abstract send(messages: readonly MediaJobMessage[]): Promise<void>;
}

export interface SqsSettings {
  region: string;
  endpoint: string | undefined;
  queueName: string;
}

export function createSqsClient(settings: SqsSettings): SQSClient {
  const config: SQSClientConfig = {
    region: settings.region,
    maxAttempts: 3,
    ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
  };
  return new SQSClient(config);
}

/** SQS de verdade (ou ElasticMQ pelo `AWS_ENDPOINT_URL_SQS`). A URL da fila é resolvida uma vez. */
export class SqsMediaJobsQueue extends MediaJobsQueue {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
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

  async send(messages: readonly MediaJobMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const queueUrl = await this.resolveQueueUrl();
    // SendMessageBatch aceita até 10 mensagens.
    for (let start = 0; start < messages.length; start += 10) {
      const batch = messages.slice(start, start + 10);
      const result = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message),
          })),
        }),
      );
      if (result.Failed !== undefined && result.Failed.length > 0) {
        throw new Error(
          `SQS recusou ${String(result.Failed.length)} mensagem(ns): ${result.Failed.map((item) => item.Code).join(', ')}`,
        );
      }
    }
  }
}
