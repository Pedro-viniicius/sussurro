// O que só se verifica com o SQS e o S3 de verdade (ElasticMQ e SeaweedFS do compose):
// - o redrive para a DLQ depois de 3 entregas (MID-10), com uma fila e uma DLQ criadas aqui;
// - leitura, gravação e remoção de objetos pelo adaptador S3 do worker.
// Pulado com TEST_DB=pglite: sem Docker não há ElasticMQ nem SeaweedFS (os fakes em memória cobrem
// o comportamento nos outros arquivos).
import { randomBytes } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { isPgliteMode } from '@sussurro/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSqsClient, SqsMessageQueue } from '../src/infra/queue.js';
import { createS3Client, S3ObjectStorage } from '../src/infra/storage.js';

const region = process.env.AWS_REGION ?? 'sa-east-1';
// Credenciais do compose (infra/local/s3.json); sem variável, nunca cai na AWS real.
for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
  if ((process.env[name] ?? '').trim() === '') {
    process.env[name] = 'local';
  }
}

describe.skipIf(isPgliteMode())('SQS e S3 reais (compose)', () => {
  const suffix = randomBytes(4).toString('hex');
  const sqs = createSqsClient({
    region,
    endpoint: process.env.AWS_ENDPOINT_URL_SQS ?? 'http://localhost:9324',
    queueName: '',
  });
  let queueUrl = '';
  let dlqUrl = '';

  beforeAll(async () => {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `media-jobs-dlq-${suffix}` }));
    dlqUrl = dlq.QueueUrl ?? '';
    const attributes = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
    );
    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: `media-jobs-${suffix}`,
        Attributes: {
          VisibilityTimeout: '1',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: attributes.Attributes?.QueueArn,
            maxReceiveCount: 3,
          }),
        },
      }),
    );
    queueUrl = queue.QueueUrl ?? '';
  });

  afterAll(async () => {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    sqs.destroy();
  });

  it('[MID-10] mensagem não apagada em 3 entregas vai para a DLQ, com o ApproximateReceiveCount', async () => {
    const queue = new SqsMessageQueue(sqs, `media-jobs-${suffix}`);
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ type: 'post-media', mediaId: crypto.randomUUID() }),
      }),
    );
    const counts: number[] = [];
    for (let round = 0; round < 6 && counts.length < 3; round++) {
      const messages = await queue.receive(1, 2);
      counts.push(...messages.map((message) => message.receiveCount));
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
    expect(counts).toEqual([1, 2, 3]);
    expect(await queue.receive(1, 2)).toEqual([]);
    const dead = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 2 }),
    );
    expect(dead.Messages).toHaveLength(1);
  });

  it('S3: grava, lê, recusa objeto acima do limite e apaga (idempotente)', async () => {
    const storage = new S3ObjectStorage(
      createS3Client({
        region,
        bucket: process.env.S3_BUCKET_MEDIA ?? 'sussurro-media',
        endpoint: process.env.AWS_ENDPOINT_URL_S3 ?? 'http://localhost:8333',
        forcePathStyle: true,
      }),
      process.env.S3_BUCKET_MEDIA ?? 'sussurro-media',
    );
    const key = `media/teste-${suffix}/full.jpg`;
    await storage.put(key, Buffer.from('conteudo'), 'image/jpeg');
    expect((await storage.get(key, 100))?.toString()).toBe('conteudo');
    await expect(storage.get(key, 3)).rejects.toThrow(/acima do limite/);
    await storage.deleteObjects([key, `media/teste-${suffix}/inexistente.jpg`]);
    expect(await storage.get(key, 100)).toBeNull();
  });

  it('S3 (Fase 5): HEAD, leitura por intervalo (Range) e cópia dentro do bucket com outro tipo', async () => {
    const storage = new S3ObjectStorage(
      createS3Client({
        region,
        bucket: process.env.S3_BUCKET_MEDIA ?? 'sussurro-media',
        endpoint: process.env.AWS_ENDPOINT_URL_S3 ?? 'http://localhost:8333',
        forcePathStyle: true,
      }),
      process.env.S3_BUCKET_MEDIA ?? 'sussurro-media',
    );
    const source = `incoming/teste-${suffix}/video`;
    const target = `media/teste-${suffix}/video.mp4`;
    await storage.put(source, Buffer.from('0123456789abcdef'), 'video/quicktime');
    expect(await storage.head(source)).toEqual({ size: 16, contentType: 'video/quicktime' });
    expect(await storage.head(`incoming/teste-${suffix}/inexistente`)).toBeNull();
    expect((await storage.getRange(source, 4, 6)).toString()).toBe('456789');
    expect((await storage.getRange(source, 12, 100)).toString()).toBe('cdef');
    await storage.copy(source, target, 'video/mp4');
    expect(await storage.head(target)).toEqual({ size: 16, contentType: 'video/mp4' });
    await storage.deleteObjects([source, target]);
  });
});
