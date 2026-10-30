import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

/** Mensagem recebida da fila. */
export interface QueueMessage {
  id: string;
  /** Para apagar a mensagem depois de processada. */
  receiptHandle: string;
  body: string;
  /** Quantas vezes a mensagem foi entregue, incluindo esta (`ApproximateReceiveCount`). */
  receiveCount: number;
  /**
   * Atributos de texto da mensagem (Fase 6: o `traceparent` do OpenTelemetry, quando a API o
   * propagou). Nunca dados de conta.
   */
  attributes?: Record<string, string>;
}

/**
 * Porta da fila `media-jobs` do lado do worker (ADR 0009). Mensagem não apagada volta depois do
 * visibility timeout; depois de `maxReceiveCount` entregas, a fila a move para a DLQ (redrive).
 */
export abstract class MessageQueue {
  /** `signal` interrompe o long polling no desligamento. */
  abstract receive(
    maxMessages: number,
    waitTimeSeconds: number,
    signal?: AbortSignal,
  ): Promise<QueueMessage[]>;
  abstract delete(receiptHandle: string): Promise<void>;
}

export interface SqsSettings {
  region: string;
  endpoint: string | undefined;
  queueName: string;
}

export function createSqsClient(settings: SqsSettings): SQSClient {
  return new SQSClient({
    region: settings.region,
    maxAttempts: 3,
    ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
  });
}

/** SQS de verdade (ou ElasticMQ pelo `AWS_ENDPOINT_URL_SQS`). */
export class SqsMessageQueue extends MessageQueue {
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
        this.queueUrl = undefined;
        throw error;
      });
    return this.queueUrl;
  }

  async receive(
    maxMessages: number,
    waitTimeSeconds: number,
    signal?: AbortSignal,
  ): Promise<QueueMessage[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MaxNumberOfMessages: Math.min(10, Math.max(1, maxMessages)),
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        MessageAttributeNames: ['traceparent', 'tracestate'],
      }),
      signal === undefined ? {} : { abortSignal: signal },
    );
    return (result.Messages ?? []).flatMap((message) =>
      message.MessageId === undefined || message.ReceiptHandle === undefined
        ? []
        : [
            {
              id: message.MessageId,
              receiptHandle: message.ReceiptHandle,
              body: message.Body ?? '',
              receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
              attributes: Object.fromEntries(
                Object.entries(message.MessageAttributes ?? {}).flatMap(([name, value]) =>
                  value.StringValue === undefined ? [] : [[name, value.StringValue]],
                ),
              ),
            },
          ],
    );
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        ReceiptHandle: receiptHandle,
      }),
    );
  }
}
