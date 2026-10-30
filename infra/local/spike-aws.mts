// Spike S3/SQS da Fase 0 (F0-DC-07 em testes.md §10.3; infra.md §3.1 e §3.3).
//
// Valida, contra os emuladores do docker-compose (SeaweedFS e ElasticMQ), o subconjunto de S3 e
// SQS que o Sussurro usa, com o mesmo AWS SDK v3 que a API e o worker vão usar. Imprime OK/FALHA
// por item e sai com código 1 se algo falhar. Qualquer FALHA vira decisão do PO (D2: LocalStack).
//
// Uso, com o compose no ar (docker compose up -d --wait):
//   pnpm spike:aws              itens automáticos
//   pnpm spike:aws --celular    + PUT pré-assinado feito do celular (passo manual, até 10 min)
//
// Lê o .env da raiz. Só aceita endpoints locais ou da LAN: nunca fala com a AWS real.
// Tudo o que cria (objetos em incoming/spike-*, filas spike-*) é apagado no fim.
// Lint e typecheck: pnpm lint / pnpm typecheck (tarefas //#lint:root e //#typecheck:root do turbo).

import { createHash, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ---------------------------------------------------------------------------------------------
// Configuração (mesmas variáveis do .env.example)

/** Valor da variável; vazia (`VAR=` no .env) conta como ausente. */
const env = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? fallback : value;
};

const config = {
  region: env('AWS_REGION', 'sa-east-1'),
  credentials: {
    accessKeyId: env('AWS_ACCESS_KEY_ID', 'local'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY', 'local'),
  },
  s3Endpoint: env('AWS_ENDPOINT_URL_S3', 'http://localhost:8333'),
  s3PublicEndpoint: env('S3_PUBLIC_ENDPOINT_URL', ''),
  sqsEndpoint: env('AWS_ENDPOINT_URL_SQS', 'http://localhost:9324'),
  forcePathStyle: env('S3_FORCE_PATH_STYLE', 'true') !== 'false',
  bucket: env('S3_BUCKET_MEDIA', 'sussurro-media'),
  // Filas declaradas em infra/local/elasticmq.conf (visibility timeout em segundos).
  queues: [
    { name: env('SQS_QUEUE_MEDIA_JOBS', 'media-jobs'), visibilityTimeout: 120 },
    { name: env('SQS_QUEUE_VIDEO_EVENTS', 'video-events'), visibilityTimeout: 60 },
    { name: env('SQS_QUEUE_PUSH', 'push'), visibilityTimeout: 60 },
  ],
  maxReceiveCount: 3,
};

const withPhone = process.argv.includes('--celular');

/** localhost, 127.0.0.0/8 ou faixas privadas da LAN. Qualquer outra coisa pode ser a AWS real. */
function isLocalEndpoint(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

const endpoints = [config.s3Endpoint, config.sqsEndpoint, config.s3PublicEndpoint].filter(Boolean);
const remote = endpoints.filter((url) => !isLocalEndpoint(url));
if (remote.length > 0) {
  console.error(
    `Endpoint fora da máquina/LAN: ${remote.join(', ')}. O spike só roda nos emuladores.`,
  );
  process.exit(2);
}

// O mesmo ajuste que a API deve usar com emuladores: sem checksum "flexível" (CRC32) automático,
// que o SDK v3 põe em PutObject e que serviços compatíveis com S3 nem sempre aceitam. Com a AWS
// real o valor também funciona.
const clientDefaults = {
  region: config.region,
  credentials: config.credentials,
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
};
const s3Defaults = {
  ...clientDefaults,
  forcePathStyle: config.forcePathStyle,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
} as const;

/** Cliente usado pela API para HEAD/GET/Delete (AWS_ENDPOINT_URL_S3). */
const s3 = new S3Client({ ...s3Defaults, endpoint: config.s3Endpoint });
/** Cliente só para assinar URLs que o celular usa (S3_PUBLIC_ENDPOINT_URL): o host entra na assinatura. */
const s3Public = new S3Client({
  ...s3Defaults,
  endpoint: config.s3PublicEndpoint || config.s3Endpoint,
});
const sqs = new SQSClient({ ...clientDefaults, endpoint: config.sqsEndpoint });

// ---------------------------------------------------------------------------------------------
// Relatório

type Status = 'OK' | 'FALHA' | 'PULADO';
const tally: Record<Status, number> = { OK: 0, FALHA: 0, PULADO: 0 };

/** Falha de verificação (a mensagem já explica o que se esperava). */
class Falha extends Error {}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Falha(message);
  }
}

function print(status: Status, id: string, title: string, detail?: string): void {
  tally[status] += 1;
  console.log(`${`[${status}]`.padEnd(9)}${id.padEnd(7)}${title}`);
  if (detail) {
    console.log(`${' '.repeat(16)}${detail}`);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Falha) {
    return error.message;
  }
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { $metadata, code, cause } = error as Error & {
    $metadata?: { httpStatusCode?: number };
    code?: string;
    cause?: { code?: string };
  };
  const errno = code ?? cause?.code;
  const parts = [
    error.name === 'Error' ? '' : error.name,
    $metadata?.httpStatusCode ? `HTTP ${$metadata.httpStatusCode}` : '',
    errno ?? '',
    error.message,
  ].filter(Boolean);
  const unreachable = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'];
  const hint =
    (errno && unreachable.includes(errno)) || error.name === 'TimeoutError'
      ? ' → o compose está no ar (docker compose up -d --wait)? O IP do .env é o deste PC?'
      : '';
  return parts.join(' · ') + hint;
}

async function check(id: string, title: string, run: () => Promise<string | undefined>) {
  try {
    print('OK', id, title, await run());
    return true;
  } catch (error) {
    print('FALHA', id, title, describeError(error));
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Utilitários S3

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Código de erro do XML do S3 (ex.: SignatureDoesNotMatch, AccessDenied). */
const s3ErrorCode = (xml: string): string => /<Code>([^<]+)<\/Code>/.exec(xml)?.[1] ?? 'sem código';

/** Assina um PUT como a API vai fazer: Content-Type sempre assinado; Content-Length quando informado. */
async function presignPut(key: string, contentType: string, expiresIn: number, length?: number) {
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: contentType,
    ...(length === undefined ? {} : { ContentLength: length }),
  });
  // O presigner não assina Content-Type por padrão: é preciso pedir.
  return getSignedUrl(s3Public, command, { expiresIn, signableHeaders: new Set(['content-type']) });
}

/** PUT como o app faz: corpo binário e o Content-Type declarado. */
async function putWithUrl(url: string, body: Uint8Array, contentType: string) {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
    headers: { 'content-type': contentType },
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: response.status,
    text: await response.text(),
    date: response.headers.get('date'),
  };
}

/**
 * PUT que deve ser recusado. Conta como recusa um HTTP 4xx/5xx ou o servidor encerrar a conexão
 * antes de ler o corpo (comum quando ele responde 403 de imediato). `accepted` descreve a falha.
 */
async function putExpectingRejection(
  url: string,
  body: Uint8Array,
  contentType: string,
  accepted: string,
): Promise<string> {
  let response: Awaited<ReturnType<typeof putWithUrl>>;
  try {
    response = await putWithUrl(url, body, contentType);
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'EPIPE') {
      return `conexão encerrada pelo servidor (${code})`;
    }
    throw error;
  }
  ensure(response.status >= 400, `aceitou (HTTP ${response.status}) ${accepted}`);
  return `HTTP ${response.status} ${s3ErrorCode(response.text)}`;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) {
      return false;
    }
    throw error;
  }
}

/** Avisa se o S3_PUBLIC_ENDPOINT_URL não aponta para um IP desta máquina (celular não alcançaria). */
function lanWarning(): string | undefined {
  if (!config.s3PublicEndpoint) {
    return 'S3_PUBLIC_ENDPOINT_URL está vazia no .env.';
  }
  const host = new URL(config.s3PublicEndpoint).hostname;
  const local = Object.values(networkInterfaces())
    .flat()
    .filter((net) => net?.family === 'IPv4' && !net.internal)
    .map((net) => net?.address ?? '');
  if (host === 'localhost' || host.startsWith('127.')) {
    return `S3_PUBLIC_ENDPOINT_URL usa ${host}: o celular não alcança. IPs deste PC: ${local.join(', ')}.`;
  }
  if (!local.includes(host)) {
    return `S3_PUBLIC_ENDPOINT_URL aponta para ${host}, mas os IPs deste PC são: ${local.join(', ')}.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// S3 (SeaweedFS)

const runId = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
const prefix = `incoming/spike-${runId}`;
const keysToClean = new Set<string>();

async function runS3(): Promise<void> {
  const contentType = 'image/jpeg';
  const body = randomBytes(64 * 1024);
  const key = `${prefix}/foto.jpg`;
  let clockSkew: number | undefined;

  const bucketOk = await check(
    'S3-0',
    `Bucket ${config.bucket} existe (criado pelo s3-init)`,
    async () => {
      await s3.send(new HeadBucketCommand({ Bucket: config.bucket }));
      return undefined;
    },
  );
  if (!bucketOk) {
    for (const [id, title] of [
      ['S3-1', 'PUT pré-assinado via S3_PUBLIC_ENDPOINT_URL'],
      ['S3-2', 'PUT com Content-Length maior que o assinado é recusado'],
      ['S3-3', 'PUT com Content-Type diferente do assinado é recusado'],
      ['S3-4', 'PUT depois da expiração é recusado'],
      ['S3-5', 'HEAD do objeto'],
      ['S3-6', 'GET pré-assinado'],
      ['S3-7', 'DeleteObject'],
    ] as const) {
      print('PULADO', id, title, 'depende do S3-0');
    }
    return;
  }

  const putOk = await check('S3-1', 'PUT pré-assinado via S3_PUBLIC_ENDPOINT_URL', async () => {
    ensure(
      config.s3PublicEndpoint,
      'S3_PUBLIC_ENDPOINT_URL vazia no .env (use http://<IP-do-PC>:8333)',
    );
    const url = new URL(await presignPut(key, contentType, 600, body.length));
    const expectedHost = new URL(config.s3PublicEndpoint).host;
    ensure(
      url.host === expectedHost,
      `a URL saiu com o host ${url.host}, esperado ${expectedHost}`,
    );
    const signed = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
    ensure(
      signed.split(';').includes('content-length') && signed.split(';').includes('content-type'),
      `Content-Length e Content-Type deveriam estar assinados; assinados: ${signed}`,
    );
    const response = await putWithUrl(url.href, body, contentType);
    keysToClean.add(key);
    ensure(response.status === 200, `HTTP ${response.status} ${s3ErrorCode(response.text)}`);
    if (response.date) {
      clockSkew = Math.round((new Date(response.date).getTime() - Date.now()) / 1000);
    }
    return `host ${url.host}; assinados: ${signed}`;
  });

  await check('S3-2', 'PUT com Content-Length maior que o assinado é recusado', async () => {
    const bigKey = `${prefix}/maior.jpg`;
    const url = await presignPut(bigKey, contentType, 600, body.length);
    keysToClean.add(bigKey);
    const bigger = Buffer.concat([body, randomBytes(1024)]);
    const result = await putExpectingRejection(
      url,
      bigger,
      contentType,
      'um corpo 1 KiB maior que o assinado',
    );
    ensure(!(await objectExists(bigKey)), `recusou (${result}), mas o objeto foi gravado`);
    return result;
  });

  // Complementar: arquitetura.md §9 assina Content-Type e Content-Length (base do MID-02/MID-03).
  await check('S3-3', 'PUT com Content-Type diferente do assinado é recusado', async () => {
    const typeKey = `${prefix}/tipo.jpg`;
    const url = await presignPut(typeKey, contentType, 600, body.length);
    keysToClean.add(typeKey);
    const result = await putExpectingRejection(
      url,
      body,
      'text/html',
      'text/html numa URL assinada para image/jpeg',
    );
    ensure(!(await objectExists(typeKey)), `recusou (${result}), mas o objeto foi gravado`);
    return result;
  });

  await check('S3-4', 'PUT depois da expiração é recusado', async () => {
    const lateKey = `${prefix}/expirado.jpg`;
    const url = await presignPut(lateKey, contentType, 1, body.length);
    keysToClean.add(lateKey);
    await sleep(3_000);
    const skew =
      clockSkew === undefined
        ? ''
        : ` (relógio do container ${clockSkew >= 0 ? '+' : ''}${clockSkew} s)`;
    const result = await putExpectingRejection(
      url,
      body,
      contentType,
      `um PUT 2 s depois de expirar${skew}. Relógio do WSL atrasado? Tente wsl --shutdown`,
    );
    ensure(!(await objectExists(lateKey)), `recusou (${result}), mas o objeto foi gravado`);
    return result + skew;
  });

  if (!putOk) {
    for (const [id, title] of [
      ['S3-5', 'HEAD do objeto'],
      ['S3-6', 'GET pré-assinado'],
      ['S3-7', 'DeleteObject'],
    ] as const) {
      print('PULADO', id, title, 'depende do S3-1');
    }
    return;
  }

  await check('S3-5', 'HEAD do objeto (tamanho e tipo conferidos pela API)', async () => {
    const head = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    ensure(
      head.ContentLength === body.length,
      `ContentLength ${head.ContentLength}, esperado ${body.length}`,
    );
    ensure(
      head.ContentType === contentType,
      `ContentType ${head.ContentType}, esperado ${contentType}`,
    );
    return `${head.ContentLength} bytes, ${head.ContentType}`;
  });

  await check(
    'S3-6',
    'GET pré-assinado via S3_PUBLIC_ENDPOINT_URL (MEDIA_URL_SIGNER=s3-presign)',
    async () => {
      const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
      const url = await getSignedUrl(s3Public, command, { expiresIn: 60 });
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      ensure(
        response.status === 200,
        `HTTP ${response.status} ${s3ErrorCode(await response.text())}`,
      );
      const received = new Uint8Array(await response.arrayBuffer());
      ensure(sha256(received) === sha256(body), 'o conteúdo baixado difere do enviado');
      return `${received.length} bytes, sha256 confere`;
    },
  );

  await check('S3-7', 'DeleteObject', async () => {
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    ensure(!(await objectExists(key)), 'o objeto continua existindo depois do DeleteObject');
    keysToClean.delete(key);
    return 'HEAD depois do delete → 404';
  });
}

/** Passo manual: o PO faz o PUT do celular, na mesma Wi-Fi. */
async function runPhone(): Promise<void> {
  const title = 'PUT pré-assinado feito do celular (manual)';
  if (!withPhone) {
    print('PULADO', 'S3-8', title, 'rode "pnpm spike:aws --celular" com o celular na mesma Wi-Fi');
    return;
  }
  await check('S3-8', title, async () => {
    ensure(config.s3PublicEndpoint, 'S3_PUBLIC_ENDPOINT_URL vazia no .env');
    const key = `${prefix}/celular.jpg`;
    keysToClean.add(key);
    // Sem Content-Length assinado: o tamanho da foto escolhida no celular não é conhecido aqui.
    const url = await presignPut(key, 'image/jpeg', 600);
    console.log(`
  Passo manual (a URL vale 10 min). Com o celular na mesma Wi-Fi do PC:
   1. Teste a rede: abra ${config.s3PublicEndpoint}/healthz no navegador do celular (página em branco = ok).
   2. Envie uma foto JPEG com método PUT para a URL abaixo, com o cabeçalho Content-Type: image/jpeg.
      iPhone: app Atalhos → "Obter Conteúdo do URL" (Método PUT, Cabeçalho, Corpo: Arquivo).
      Android: um cliente HTTP (ex.: HTTP Shortcuts) com corpo = arquivo.

  ${url}

  Aguardando o objeto chegar (Ctrl+C cancela)...`);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      if (await objectExists(key)) {
        const head = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return `${head.ContentLength} bytes recebidos do celular, ${head.ContentType}`;
      }
      await sleep(3_000);
    }
    throw new Falha(
      'nada chegou em 10 min (firewall da porta 8333? rede Wi-Fi marcada como Privada?)',
    );
  });
}

// ---------------------------------------------------------------------------------------------
// SQS (ElasticMQ)

const tempQueues: string[] = [];

async function receiveOne(queueUrl: string, waitSeconds: number, visibilityTimeout?: number) {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: waitSeconds,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['All'],
      ...(visibilityTimeout === undefined ? {} : { VisibilityTimeout: visibilityTimeout }),
    }),
  );
  return result.Messages?.[0];
}

const receiveCount = (message: Message): string =>
  message.Attributes?.ApproximateReceiveCount ?? '?';

async function deleteMessage(queueUrl: string, message: Message): Promise<void> {
  if (message.ReceiptHandle) {
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }
}

async function runSqs(): Promise<void> {
  await check('SQS-0', 'Filas e DLQs do elasticmq.conf (3 recebimentos)', async () => {
    const found: string[] = [];
    for (const queue of config.queues) {
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queue.name }));
      ensure(QueueUrl, `fila ${queue.name} não encontrada`);
      const { Attributes = {} } = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }),
      );
      ensure(
        Attributes.VisibilityTimeout === String(queue.visibilityTimeout),
        `${queue.name}: VisibilityTimeout ${Attributes.VisibilityTimeout}, esperado ${queue.visibilityTimeout}`,
      );
      const redrive = JSON.parse(Attributes.RedrivePolicy ?? '{}') as {
        deadLetterTargetArn?: string;
        maxReceiveCount?: number | string;
      };
      ensure(
        Number(redrive.maxReceiveCount) === config.maxReceiveCount &&
          redrive.deadLetterTargetArn?.endsWith(`:${queue.name}-dlq`),
        `${queue.name}: RedrivePolicy inesperada: ${Attributes.RedrivePolicy ?? 'ausente'}`,
      );
      await sqs.send(new GetQueueUrlCommand({ QueueName: `${queue.name}-dlq` }));
      found.push(`${queue.name} (${queue.visibilityTimeout} s → ${queue.name}-dlq)`);
    }
    return found.join(', ');
  });

  // Filas temporárias: não mexe nas filas de desenvolvimento (o worker consome a partir da Fase 2).
  const queueName = `spike-${runId}`;
  let queueUrl = '';
  let dlqUrl = '';
  const setupOk = await check(
    'SQS-1',
    'Cria fila temporária com DLQ (RedrivePolicy, 3 recebimentos)',
    async () => {
      const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `${queueName}-dlq` }));
      ensure(dlq.QueueUrl, 'CreateQueue da DLQ não devolveu a URL');
      dlqUrl = dlq.QueueUrl;
      tempQueues.push(dlqUrl);
      const { Attributes = {} } = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
      );
      ensure(Attributes.QueueArn, 'a DLQ não informou o QueueArn');
      const main = await sqs.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: {
            VisibilityTimeout: '2',
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: Attributes.QueueArn,
              maxReceiveCount: config.maxReceiveCount,
            }),
          },
        }),
      );
      ensure(main.QueueUrl, 'CreateQueue não devolveu a URL');
      queueUrl = main.QueueUrl;
      tempQueues.push(queueUrl);
      return queueUrl;
    },
  );

  if (!setupOk) {
    for (const [id, title] of [
      ['SQS-2', 'Envio e recebimento'],
      ['SQS-3', 'Visibility timeout'],
      ['SQS-4', 'Mensagem vai para a DLQ após 3 recebimentos'],
    ] as const) {
      print('PULADO', id, title, 'depende do SQS-1');
    }
    return;
  }

  await check('SQS-2', 'Envio e recebimento (corpo e atributo traceparent)', async () => {
    const traceparent = `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
    const body = JSON.stringify({ kind: 'spike', runId });
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageAttributes: { traceparent: { DataType: 'String', StringValue: traceparent } },
      }),
    );
    const message = await receiveOne(queueUrl, 2);
    ensure(message, 'nenhuma mensagem recebida em 2 s');
    ensure(message.Body === body, `corpo diferente: ${message.Body}`);
    const attribute = message.MessageAttributes?.traceparent?.StringValue;
    ensure(attribute === traceparent, `atributo traceparent diferente: ${attribute}`);
    await deleteMessage(queueUrl, message);
    return 'corpo e traceparent conferem; mensagem apagada';
  });

  await check('SQS-3', 'Visibility timeout (some ao ser lida, volta depois de 2 s)', async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: 'visibilidade' }));
    const first = await receiveOne(queueUrl, 2);
    ensure(first, 'nenhuma mensagem recebida em 2 s');
    const hidden = await receiveOne(queueUrl, 1);
    ensure(!hidden, 'a mensagem foi entregue de novo dentro do visibility timeout');
    await sleep(2_500);
    const again = await receiveOne(queueUrl, 2);
    ensure(again, 'a mensagem não voltou depois do visibility timeout');
    ensure(again.MessageId === first.MessageId, 'voltou outra mensagem no lugar da original');
    await deleteMessage(queueUrl, again);
    return `mesma MessageId de volta; ApproximateReceiveCount=${receiveCount(again)}`;
  });

  await check('SQS-4', 'Mensagem vai para a DLQ após 3 recebimentos', async () => {
    const body = `dlq-${runId}`;
    const sent = await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
    for (let attempt = 1; attempt <= config.maxReceiveCount; attempt += 1) {
      // Recebe sem apagar (simula falha do consumidor) com visibility de 1 s.
      const message = await receiveOne(queueUrl, 3, 1);
      ensure(message?.MessageId === sent.MessageId, `recebimento ${attempt} não trouxe a mensagem`);
      await sleep(1_300);
    }
    const fourth = await receiveOne(queueUrl, 1);
    ensure(!fourth, 'a mensagem foi entregue uma 4ª vez em vez de ir para a DLQ');
    const dead = await receiveOne(dlqUrl, 3);
    ensure(dead, 'a mensagem não apareceu na DLQ');
    ensure(dead.Body === body, `a DLQ trouxe outra mensagem: ${dead.Body ?? ''}`);
    await deleteMessage(dlqUrl, dead);
    return `3 entregas, 4ª leitura vazia, mensagem na DLQ (ApproximateReceiveCount=${receiveCount(dead)})`;
  });
}

// ---------------------------------------------------------------------------------------------
// Execução

async function cleanup(): Promise<void> {
  for (const key of keysToClean) {
    await s3
      .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
      .catch(() => undefined);
  }
  for (const queueUrl of tempQueues) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
  }
}

console.log('Spike S3/SQS (F0-DC-07): SeaweedFS + ElasticMQ');
console.log(`  S3 (API):     ${config.s3Endpoint}`);
console.log(`  S3 (celular): ${config.s3PublicEndpoint || '(vazio)'}`);
console.log(`  SQS:          ${config.sqsEndpoint}`);
const warning = lanWarning();
if (warning) {
  console.log(`  AVISO: ${warning}`);
}
console.log('');

try {
  await runS3();
  await runSqs();
  await runPhone();
} finally {
  await cleanup();
}

console.log('');
console.log(`Resultado: ${tally.OK} OK, ${tally.FALHA} FALHA, ${tally.PULADO} PULADO.`);
if (tally.FALHA > 0) {
  console.log('Qualquer FALHA vira decisão do PO (D2): ajustar o emulador ou usar o LocalStack.');
  process.exitCode = 1;
}
