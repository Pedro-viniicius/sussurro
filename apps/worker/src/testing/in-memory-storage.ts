import { ObjectStorage, ObjectTooLargeError, type StoredObjectInfo } from '../infra/storage.js';

interface StoredObject {
  body: Buffer;
  contentType: string;
}

/** Fake em memória da porta `ObjectStorage` do worker (testes sem Docker). */
export class InMemoryObjectStorage extends ObjectStorage {
  readonly objects = new Map<string, StoredObject>();
  /** Cada chave apagada, na ordem (inclusive repetidas: o teste de concorrência confere). */
  readonly deletedKeys: string[] = [];
  /** Cada leitura por intervalo (o teste confere que o vídeo nunca é lido inteiro). */
  readonly rangeReads: { key: string; start: number; length: number }[] = [];
  /** Falha nas próximas N leituras (S3 fora do ar, falha transitória). */
  failGets = 0;
  /** Falha no próximo `deleteObjects` (o lote da limpeza deve ser desfeito). */
  failNextDelete = false;

  get(key: string, maxBytes: number): Promise<Buffer | null> {
    if (this.failGets > 0) {
      this.failGets -= 1;
      return Promise.reject(new Error('S3 indisponível (simulado)'));
    }
    const object = this.objects.get(key);
    if (object === undefined) {
      return Promise.resolve(null);
    }
    if (object.body.length > maxBytes) {
      return Promise.reject(new ObjectTooLargeError(key, object.body.length));
    }
    return Promise.resolve(object.body);
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
  }

  deleteObjects(keys: readonly string[]): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      return Promise.reject(new Error('S3 indisponível (simulado)'));
    }
    for (const key of keys) {
      this.objects.delete(key);
      this.deletedKeys.push(key);
    }
    return Promise.resolve();
  }

  head(key: string): Promise<StoredObjectInfo | null> {
    if (this.failGets > 0) {
      this.failGets -= 1;
      return Promise.reject(new Error('S3 indisponível (simulado)'));
    }
    const object = this.objects.get(key);
    return Promise.resolve(
      object === undefined ? null : { size: object.body.length, contentType: object.contentType },
    );
  }

  getRange(key: string, start: number, length: number): Promise<Buffer> {
    const object = this.objects.get(key);
    if (object === undefined) {
      return Promise.reject(new Error(`NoSuchKey: ${key}`));
    }
    this.rangeReads.push({ key, start, length });
    return Promise.resolve(Buffer.from(object.body.subarray(start, start + Math.max(0, length))));
  }

  copy(fromKey: string, toKey: string, contentType: string): Promise<void> {
    const object = this.objects.get(fromKey);
    if (object === undefined) {
      return Promise.reject(new Error(`NoSuchKey: ${fromKey}`));
    }
    this.objects.set(toKey, { body: Buffer.from(object.body), contentType });
    return Promise.resolve();
  }

  clear(): void {
    this.objects.clear();
    this.deletedKeys.length = 0;
    this.rangeReads.length = 0;
    this.failGets = 0;
    this.failNextDelete = false;
  }
}
