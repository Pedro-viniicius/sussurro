import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/** Tamanho e tipo de um objeto (HEAD). */
export interface StoredObjectInfo {
  size: number;
  contentType: string | undefined;
}

/**
 * Porta do armazenamento de objetos do worker: ler o original em `incoming/`, gravar as saídas em
 * `media/` e apagar. S3 em produção, SeaweedFS em dev, fake em memória nos testes sem Docker.
 * (Fase 5) Vídeo: o worker nunca baixa o vídeo inteiro; lê só os cabeçalhos do container por
 * intervalo (`getRange`) e o passthrough copia dentro do próprio S3 (`copy`).
 */
export abstract class ObjectStorage {
  /** Bytes do objeto, ou `null` se não existe. Recusa objetos acima de `maxBytes`. */
  abstract get(key: string, maxBytes: number): Promise<Buffer | null>;
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Idempotente: chave inexistente não é erro. */
  abstract deleteObjects(keys: readonly string[]): Promise<void>;
  /** `null` se o objeto não existe. */
  abstract head(key: string): Promise<StoredObjectInfo | null>;
  /**
   * Até `length` bytes a partir de `start` (menos no fim do arquivo). O objeto precisa existir:
   * confira antes com `head`.
   */
  abstract getRange(key: string, start: number, length: number): Promise<Buffer>;
  /** Cópia dentro do bucket (sem passar os bytes pelo worker), com o `Content-Type` dado. */
  abstract copy(fromKey: string, toKey: string, contentType: string): Promise<void>;
}

/** Objeto maior que o permitido (o S3 já limitou pela assinatura; é defesa em profundidade). */
export class ObjectTooLargeError extends Error {
  constructor(key: string, size: number) {
    super(`Objeto ${key} com ${String(size)} bytes acima do limite`);
    this.name = 'ObjectTooLargeError';
  }
}

export interface S3Settings {
  region: string;
  bucket: string;
  endpoint: string | undefined;
  forcePathStyle: boolean;
}

export function createS3Client(settings: S3Settings): S3Client {
  return new S3Client({
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    // Sem o checksum "flexível" automático do SDK v3 (emuladores, F0-DC-07).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
    ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
  });
}

function httpStatusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  return httpStatusOf(error) === 404 || name === 'NoSuchKey' || name === 'NotFound';
}

/** `CopySource` do S3: `bucket/chave`, com cada parte da chave codificada. */
function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** S3 de verdade (ou SeaweedFS/LocalStack pelo `AWS_ENDPOINT_URL_S3`). */
export class S3ObjectStorage extends ObjectStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    super();
  }

  async get(key: string, maxBytes: number): Promise<Buffer | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const size = result.ContentLength ?? 0;
      if (size > maxBytes) {
        result.Body?.transformToWebStream()
          .cancel()
          .catch(() => undefined);
        throw new ObjectTooLargeError(key, size);
      }
      const bytes = await result.Body?.transformToByteArray();
      return bytes === undefined ? Buffer.alloc(0) : Buffer.from(bytes);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += 1000) {
      const batch = keys.slice(start, start + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { size: result.ContentLength ?? 0, contentType: result.ContentType };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async getRange(key: string, start: number, length: number): Promise<Buffer> {
    if (length <= 0) {
      return Buffer.alloc(0);
    }
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=${String(start)}-${String(start + length - 1)}`,
      }),
    );
    // Defesa: um servidor que ignorasse o Range mandaria o vídeo inteiro para a memória.
    if ((result.ContentLength ?? 0) > length) {
      result.Body?.transformToWebStream()
        .cancel()
        .catch(() => undefined);
      throw new Error(`O S3 ignorou o Range na leitura de ${key}`);
    }
    const bytes = await result.Body?.transformToByteArray();
    return bytes === undefined ? Buffer.alloc(0) : Buffer.from(bytes);
  }

  async copy(fromKey: string, toKey: string, contentType: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: toKey,
        CopySource: copySource(this.bucket, fromKey),
        ContentType: contentType,
        MetadataDirective: 'REPLACE',
      }),
    );
  }
}
