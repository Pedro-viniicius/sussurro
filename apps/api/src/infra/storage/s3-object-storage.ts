import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  MediaUrlSigner,
  type ObjectHead,
  ObjectStorage,
  type PresignPutInput,
} from './object-storage.js';

export interface S3Settings {
  region: string;
  bucket: string;
  /** HEAD/Delete (SeaweedFS em dev). `undefined` = AWS real. */
  endpoint: string | undefined;
  /** Host que entra nas URLs pré-assinadas (o celular as usa). */
  publicEndpoint: string | undefined;
  forcePathStyle: boolean;
}

/**
 * Configuração comum dos clientes S3. Sem checksum "flexível" automático (CRC32), que o SDK v3 põe
 * nos PUTs e que os emuladores nem sempre aceitam (validado no spike da Fase 0, F0-DC-07).
 */
function clientConfig(settings: S3Settings, endpoint: string | undefined): S3ClientConfig {
  return {
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

export function createS3Clients(settings: S3Settings): { internal: S3Client; public: S3Client } {
  const internal = new S3Client(clientConfig(settings, settings.endpoint));
  const publicClient =
    settings.publicEndpoint === undefined || settings.publicEndpoint === settings.endpoint
      ? internal
      : new S3Client(clientConfig(settings, settings.publicEndpoint));
  return { internal, public: publicClient };
}

/**
 * URL PUT pré-assinada com `Content-Type` e `Content-Length` na assinatura (ADR 0009): o S3 recusa
 * um arquivo de outro tipo ou tamanho. O presigner não assina `Content-Type` por padrão.
 */
export function presignPutUrl(
  client: S3Client,
  bucket: string,
  input: PresignPutInput,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: input.key,
    ContentType: input.contentType,
    ContentLength: input.contentLength,
  });
  return getSignedUrl(client, command, {
    expiresIn: input.expiresInS,
    signingDate: input.signingDate,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
}

function httpStatusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

/** S3 de verdade (ou SeaweedFS/LocalStack pelo `AWS_ENDPOINT_URL_S3`). */
export class S3ObjectStorage extends ObjectStorage {
  constructor(
    private readonly clients: { internal: S3Client; public: S3Client },
    private readonly bucket: string,
  ) {
    super();
  }

  presignPut(input: PresignPutInput): Promise<string> {
    return presignPutUrl(this.clients.public, this.bucket, input);
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const head = await this.clients.internal.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { contentLength: head.ContentLength ?? 0, contentType: head.ContentType };
    } catch (error) {
      const status = httpStatusOf(error);
      if (status === 404 || status === 403) {
        return null;
      }
      throw error;
    }
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    // DeleteObjects aceita até 1000 chaves por chamada.
    for (let start = 0; start < keys.length; start += 1000) {
      const batch = keys.slice(start, start + 1000);
      await this.clients.internal.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}

/**
 * Leitura em dev (infra.md §3.3): sem CloudFront, a API gera um GET pré-assinado no SeaweedFS, pelo
 * endpoint público (o celular baixa direto). URL adulterada → 403 do próprio S3.
 */
export class S3PresignMediaUrlSigner extends MediaUrlSigner {
  constructor(
    private readonly publicClient: S3Client,
    private readonly bucket: string,
  ) {
    super();
  }

  sign(key: string, expiresAt: Date, signingDate: Date): Promise<string> {
    const expiresInS = Math.max(
      1,
      Math.round((expiresAt.getTime() - signingDate.getTime()) / 1000),
    );
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      {
        expiresIn: expiresInS,
        signingDate,
      },
    );
  }
}
