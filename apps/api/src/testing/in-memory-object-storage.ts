import { S3Client } from '@aws-sdk/client-s3';

import type { Clock } from '../common/clock/clock.js';
import {
  type ObjectHead,
  ObjectStorage,
  type PresignPutInput,
} from '../infra/storage/object-storage.js';
import { presignPutUrl } from '../infra/storage/s3-object-storage.js';

/** Endpoint fictício das URLs assinadas nos testes (nenhuma conexão é aberta). */
export const FAKE_S3_ENDPOINT = 'http://s3.teste.local:8333';
export const FAKE_S3_BUCKET = 'sussurro-media-teste';

interface StoredObject {
  body: Buffer;
  contentType: string;
}

interface UploadSlot {
  key: string;
  contentType: string;
  contentLength: number;
  expiresAt: number;
}

export interface UploadResult {
  status: number;
  /** Código de erro do S3 quando recusado. */
  code?: 'AccessDenied' | 'SignatureDoesNotMatch' | 'NoSuchUpload';
}

/**
 * Fake em memória da porta `ObjectStorage` (modo sem Docker). As URLs são assinadas pelo mesmo
 * presigner do SDK que a produção usa (SigV4, sem rede), e `upload()` reproduz o que o S3 faz com
 * elas: recusa depois do vencimento (MID-07) e com tipo ou tamanho diferente do assinado (MID-03).
 * A recusa de verdade pelo S3 é testada contra o SeaweedFS (fora do modo PGlite).
 */
export class InMemoryObjectStorage extends ObjectStorage {
  readonly objects = new Map<string, StoredObject>();
  /** Chaves apagadas, na ordem (para conferir a limpeza). */
  readonly deletedKeys: string[] = [];
  private readonly slots = new Map<string, UploadSlot>();
  private readonly client = new S3Client({
    region: 'sa-east-1',
    endpoint: FAKE_S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: 'teste', secretAccessKey: 'teste' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  constructor(private readonly clock: Clock) {
    super();
  }

  async presignPut(input: PresignPutInput): Promise<string> {
    const url = await presignPutUrl(this.client, FAKE_S3_BUCKET, input);
    this.slots.set(url, {
      key: input.key,
      contentType: input.contentType,
      contentLength: input.contentLength,
      expiresAt: input.signingDate.getTime() + input.expiresInS * 1000,
    });
    return url;
  }

  /** O PUT do app na URL pré-assinada, com as regras do S3. */
  upload(url: string, body: Buffer, contentType: string): UploadResult {
    const slot = this.slots.get(url);
    if (slot === undefined) {
      return { status: 403, code: 'SignatureDoesNotMatch' };
    }
    if (this.clock.now().getTime() > slot.expiresAt) {
      return { status: 403, code: 'AccessDenied' };
    }
    if (contentType !== slot.contentType || body.length !== slot.contentLength) {
      return { status: 403, code: 'SignatureDoesNotMatch' };
    }
    this.objects.set(slot.key, { body, contentType });
    return { status: 200 };
  }

  /** Grava direto (como o worker grava as saídas processadas). */
  put(key: string, body: Buffer, contentType: string): void {
    this.objects.set(key, { body, contentType });
  }

  head(key: string): Promise<ObjectHead | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object === undefined
        ? null
        : { contentLength: object.body.length, contentType: object.contentType },
    );
  }

  deleteObjects(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(key);
      this.deletedKeys.push(key);
    }
    return Promise.resolve();
  }

  clear(): void {
    this.objects.clear();
    this.slots.clear();
    this.deletedKeys.length = 0;
  }
}
