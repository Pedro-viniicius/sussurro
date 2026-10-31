// O que só se verifica com o SQS de verdade (ElasticMQ do compose; Fase 6, ADR 0011):
// - NOT-11: o `SqsPushQueue` da API entregar à fila `push` o corpo do contrato
//   (`PushJobMessageSchema`), em lotes de até 10, e, com o OpenTelemetry ligado, o `traceparent` do
//   span ativo nos atributos da mensagem, os mesmos que o consumidor do worker pede (6.8 CA1);
//   desligado, nenhum atributo;
// - NOT-12: a fila `push` do `infra/local/elasticmq.conf` mandar para a `push-dlq` a mensagem que
//   esgota as 3 entregas sem ser apagada. O consumo com o `ApproximateReceiveCount` e o redrive numa
//   fila criada no teste já estão no worker (`apps/worker/test/real-services.int-spec.ts`, MID-10):
//   aqui só a configuração da `push`.
// Usa as filas `push` e `push-dlq` da configuração do compose, sem PurgeQueue: cada teste só mexe
// nas mensagens dele (ids aleatórios no corpo). Com o worker do `pnpm dev` no ar, ele consumiria a
// fila `push` antes do teste: rode sem ele. Pulado com TEST_DB=pglite: sem Docker não há ElasticMQ
// (o fake em memória cobre o contrato nos outros arquivos).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import {
  type Context,
  context,
  type ContextManager,
  propagation,
  ROOT_CONTEXT,
  type TextMapPropagator,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import { isPgliteMode } from '@sussurro/db/testing';
import { type PushJobMessage, PushJobMessageSchema } from '@sussurro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { traceIdFromTraceparent, Tracing } from '../../src/infra/observability/tracing.js';
import { createSqsClient } from '../../src/infra/storage/media-jobs-queue.js';
import { SqsPushQueue } from '../../src/infra/storage/push-queue.js';

/** As filas do `infra/local/elasticmq.conf` (o `SQS_QUEUE_PUSH` padrão da API e do worker). */
const PUSH_QUEUE = 'push';
const PUSH_DLQ = 'push-dlq';

// Credenciais do compose (infra/local/s3.json); sem variável, nunca cai na AWS real.
for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
  if ((process.env[name] ?? '').trim() === '') {
    process.env[name] = 'local';
  }
}

/**
 * Contexto ativo do OpenTelemetry por `AsyncLocalStorage` (o que um SDK registraria): sem ele, o
 * `context.active()` da API é sempre o raiz e o teste não provaria que o span ativo é o propagado.
 */
class AsyncLocalContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    current: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(current, () => fn.call(thisArg, ...args));
  }

  bind<T>(_current: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

/** W3C Trace Context mínimo (o `@opentelemetry/core` não é dependência): só o `traceparent`. */
const traceContextPropagator: TextMapPropagator = {
  inject(current, carrier, setter) {
    const span = trace.getSpanContext(current);
    if (span === undefined || !trace.isSpanContextValid(span)) {
      return;
    }
    const flags = span.traceFlags.toString(16).padStart(2, '0');
    setter.set(carrier, 'traceparent', `00-${span.traceId}-${span.spanId}-${flags}`);
  },
  extract: (current) => current,
  fields: () => ['traceparent'],
};

describe.skipIf(isPgliteMode())('fila push no SQS real (ElasticMQ do compose)', () => {
  // O mesmo cliente que o StorageModule da API monta para a fila `push`.
  const sqs = createSqsClient({
    region: process.env.AWS_REGION ?? 'sa-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL_SQS ?? 'http://localhost:9324',
    queueName: PUSH_QUEUE,
  });
  let pushUrl = '';
  let dlqUrl = '';

  beforeAll(async () => {
    expect(context.setGlobalContextManager(new AsyncLocalContextManager())).toBe(true);
    expect(propagation.setGlobalPropagator(traceContextPropagator)).toBe(true);
    // As duas filas precisam existir na configuração: sem elas, o GetQueueUrl falha aqui.
    pushUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: PUSH_QUEUE }))).QueueUrl ?? '';
    dlqUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: PUSH_DLQ }))).QueueUrl ?? '';
    expect(pushUrl).not.toBe('');
    expect(dlqUrl).not.toBe('');
  });

  afterAll(() => {
    propagation.disable();
    context.disable();
    sqs.destroy();
  });

  /** Span "da requisição" ativo enquanto a API envia (o interceptor HTTP faria o mesmo). */
  function activeSpan() {
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    return {
      traceId,
      spanId,
      context: trace.setSpanContext(ROOT_CONTEXT, {
        traceId,
        spanId,
        traceFlags: TraceFlags.SAMPLED,
      }),
    };
  }

  /**
   * Recebe da fila até achar `want` mensagens cujo corpo está em `bodies` (as de outros testes ou
   * do dev ficam de fora), em no máximo `rounds` chamadas de até 1 s cada.
   */
  async function receiveOwn(
    queueUrl: string,
    bodies: ReadonlySet<string>,
    want: number,
    rounds = 15,
  ): Promise<Message[]> {
    const own: Message[] = [];
    for (let round = 0; round < rounds && own.length < want; round++) {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          // Os mesmos atributos que o consumidor do worker pede (apps/worker/src/infra/queue.ts).
          MessageAttributeNames: ['traceparent', 'tracestate'],
        }),
      );
      own.push(
        ...(result.Messages ?? []).filter(
          (message) => message.Body !== undefined && bodies.has(message.Body),
        ),
      );
    }
    return own;
  }

  async function remove(queueUrl: string, messages: readonly Message[]): Promise<void> {
    for (const message of messages) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }

  /** Corpo das mensagens, validado pelo contrato da fila (objeto estrito: nada além dos ids). */
  function parsedBodies(messages: readonly Message[]): PushJobMessage[] {
    return messages.map((message) => PushJobMessageSchema.parse(JSON.parse(message.Body ?? '')));
  }

  const byBody = (left: PushJobMessage, right: PushJobMessage) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right));

  it('[NOT-11] [6.8 CA1] SqsPushQueue → fila push: 12 mensagens (2 lotes do SendMessageBatch) chegam uma vez cada, com o corpo do contrato e o traceparent do span ativo nos atributos', async () => {
    const queue = new SqsPushQueue(sqs, PUSH_QUEUE, new Tracing(true, 'sussurro-api'));
    const messages: PushJobMessage[] = Array.from({ length: 12 }, (_, index) =>
      index % 3 === 2
        ? { type: 'connection-request', requestId: randomUUID() }
        : { type: 'notification', notificationId: randomUUID() },
    );
    const span = activeSpan();

    await context.with(span.context, () => queue.send(messages));

    const received = await receiveOwn(
      pushUrl,
      new Set(messages.map((message) => JSON.stringify(message))),
      messages.length,
    );
    await remove(pushUrl, received);
    expect(new Set(received.map((message) => message.MessageId)).size).toBe(received.length);
    expect(parsedBodies(received).sort(byBody)).toEqual([...messages].sort(byBody));
    for (const message of received) {
      expect(Object.keys(message.MessageAttributes ?? {})).toEqual(['traceparent']);
      expect(message.MessageAttributes?.traceparent).toMatchObject({
        DataType: 'String',
        StringValue: `00-${span.traceId}-${span.spanId}-01`,
      });
      // O worker continua o trace da API a partir deste atributo.
      expect(traceIdFromTraceparent(message.MessageAttributes?.traceparent?.StringValue)).toBe(
        span.traceId,
      );
    }
  });

  it('[NOT-11] [6.8 CA1] com o OpenTelemetry desligado (o padrão), a mensagem chega sem atributos, mesmo com um span ativo', async () => {
    const queue = new SqsPushQueue(sqs, PUSH_QUEUE, new Tracing(false, 'sussurro-api'));
    const message: PushJobMessage = { type: 'notification', notificationId: randomUUID() };

    await context.with(activeSpan().context, () => queue.send([message]));

    const received = await receiveOwn(pushUrl, new Set([JSON.stringify(message)]), 1);
    await remove(pushUrl, received);
    expect(parsedBodies(received)).toEqual([message]);
    expect(received[0]?.MessageAttributes ?? {}).toEqual({});
  });

  it('[NOT-12] a fila push do elasticmq.conf manda para a push-dlq a mensagem que esgota as 3 entregas sem ser apagada (o worker falhou 3 vezes)', async () => {
    const queue = new SqsPushQueue(sqs, PUSH_QUEUE, new Tracing(false, 'sussurro-api'));
    const message: PushJobMessage = { type: 'notification', notificationId: randomUUID() };
    const bodies = new Set([JSON.stringify(message)]);
    await queue.send([message]);

    const counts: number[] = [];
    for (let round = 0; round < 4 && counts.length < 3; round++) {
      for (const received of await receiveOwn(pushUrl, bodies, 1, 3)) {
        counts.push(Number(received.Attributes?.ApproximateReceiveCount));
        // O worker que falha não apaga: a mensagem volta depois do visibility timeout da fila
        // (60 s na configuração). Aqui ela volta na hora.
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: pushUrl,
            ReceiptHandle: received.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
      }
    }
    expect(counts).toEqual([1, 2, 3]);

    // A 4ª tentativa não entrega: o ElasticMQ move a mensagem para a DLQ.
    expect(await receiveOwn(pushUrl, bodies, 1, 2)).toEqual([]);
    const dead = await receiveOwn(dlqUrl, bodies, 1);
    await remove(dlqUrl, dead);
    expect(parsedBodies(dead)).toEqual([message]);
  });
});
