// O que só se verifica com o S3 e o SQS de verdade (SeaweedFS e ElasticMQ do compose, A-22):
// - o S3 recusar um PUT maior que o Content-Length assinado (MID-03);
// - o S3 recusar um PUT com a URL vencida (MID-07);
// - o S3 recusar um GET com assinatura adulterada ou sem assinatura (PERM-16, em dev s3-presign);
// - o publish conferir os objetos com HEAD e enviar as mensagens a uma fila SQS real.
// Pulado com TEST_DB=pglite: sem Docker não há SeaweedFS nem ElasticMQ (o fake em memória cobre o
// contrato nos outros arquivos). Usa uma fila própria, criada e apagada aqui.
import { randomBytes } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { eq, postMedia } from '@sussurro/db';
import { createPost, isPgliteMode } from '@sussurro/db/testing';
import { DraftSchema, MediaJobMessageSchema, PostSchema } from '@sussurro/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { verifiedUser } from '../support/posts.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

// Credenciais do compose (infra/local/s3.json); sem variável, nunca cai na AWS real.
for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
  if ((process.env[name] ?? '').trim() === '') {
    process.env[name] = 'local';
  }
}

describe.skipIf(isPgliteMode())('S3 e SQS reais (compose)', () => {
  const queueName = `media-jobs-teste-${randomBytes(4).toString('hex')}`;
  const sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'sa-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL_SQS ?? 'http://localhost:9324',
  });
  let queueUrl = '';
  let t: TestApp;

  beforeAll(async () => {
    const created = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
    queueUrl = created.QueueUrl ?? '';
    t = await createTestApp({
      realStorage: true,
      env: { SQS_QUEUE_MEDIA_JOBS: queueName, MEDIA_URL_SIGNER: 's3-presign' },
    });
  });

  afterAll(async () => {
    await t.close();
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    sqs.destroy();
  });

  beforeEach(async () => {
    await t.reset();
    // O S3 confere a data da assinatura com o relógio dele: aqui o relógio é o de verdade.
    t.clock.set(new Date());
  });

  async function put(url: string, body: Buffer, contentType: string): Promise<number> {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'content-type': contentType },
      });
      return response.status;
    } catch {
      // O S3 pode fechar a conexão antes de ler o corpo (recusa imediata).
      return 499;
    }
  }

  it('[MID-03] PUT maior que o declarado é recusado pelo S3 e o publish dá MEDIA_NOT_UPLOADED', async () => {
    const { headers } = await verifiedUser(t);
    const draft = DraftSchema.parse(
      (
        await t.http
          .post('/v1/posts/drafts')
          .set(headers)
          .send({ type: 'photo', items: [{ mime: 'image/jpeg', sizeBytes: 1024 }] })
          .expect(201)
      ).body,
    );
    const status = await put(draft.uploads[0]!.url, Buffer.alloc(2048), 'image/jpeg');
    expect(status).toBeGreaterThanOrEqual(400);
    await t.http.post(`/v1/posts/${draft.postId}/publish`).set(headers).send({}).expect(409);
  });

  it('[MID-07] PUT com a URL vencida é recusado pelo S3', async () => {
    const { headers } = await verifiedUser(t);
    t.clock.set(new Date(Date.now() - 11 * 60_000));
    const draft = DraftSchema.parse(
      (
        await t.http
          .post('/v1/posts/drafts')
          .set(headers)
          .send({ type: 'photo', items: [{ mime: 'image/jpeg', sizeBytes: 512 }] })
          .expect(201)
      ).body,
    );
    expect(await put(draft.uploads[0]!.url, Buffer.alloc(512), 'image/jpeg')).toBe(403);
  });

  it('[MID-08] PUT certo → publish confere com HEAD e envia uma mensagem por imagem ao SQS', async () => {
    const { headers } = await verifiedUser(t);
    const draft = DraftSchema.parse(
      (
        await t.http
          .post('/v1/posts/drafts')
          .set(headers)
          .send({ type: 'photo', items: [{ mime: 'image/png', sizeBytes: 300 }] })
          .expect(201)
      ).body,
    );
    expect(await put(draft.uploads[0]!.url, Buffer.alloc(300, 1), 'image/png')).toBe(200);
    const published = await t.http
      .post(`/v1/posts/${draft.postId}/publish`)
      .set(headers)
      .send({})
      .expect(200);
    expect(PostSchema.parse(published.body).status).toBe('processing');
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 2 }),
    );
    expect(
      (received.Messages ?? []).map((message) =>
        MediaJobMessageSchema.parse(JSON.parse(message.Body ?? '{}')),
      ),
    ).toEqual([{ type: 'post-media', mediaId: draft.uploads[0]!.mediaId }]);
  });

  it('[PERM-16] GET pré-assinado vale; adulterado ou sem assinatura → 403 do S3', async () => {
    const { user, headers } = await verifiedUser(t);
    const post = await createPost(t.database.db, user, { type: 'photo' });
    const media = post.media[0]!;
    // Grava o objeto de saída pela URL de upload do próprio S3 (como o worker faria).
    const draft = DraftSchema.parse(
      (
        await t.http
          .post('/v1/posts/drafts')
          .set(headers)
          .send({ type: 'photo', items: [{ mime: 'image/jpeg', sizeBytes: 4 }] })
          .expect(201)
      ).body,
    );
    expect(await put(draft.uploads[0]!.url, Buffer.from('jpeg'), 'image/jpeg')).toBe(200);
    const sourceKey = new URL(draft.uploads[0]!.url).pathname.split('/').slice(2).join('/');
    await t.database.db
      .update(postMedia)
      .set({ storageKey: sourceKey })
      .where(eq(postMedia.id, media.id));

    const view = PostSchema.parse(
      (await t.http.get(`/v1/posts/${post.id}`).set(headers).expect(200)).body,
    );
    const url = new URL(view.media[0]!.url!);
    expect((await fetch(url)).status).toBe(200);
    const tampered = new URL(url.href);
    tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));
    expect((await fetch(tampered)).status).toBe(403);
    expect((await fetch(`${url.origin}${url.pathname}`)).status).toBe(403);
  });
});
