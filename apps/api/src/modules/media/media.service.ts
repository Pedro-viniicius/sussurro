import { Injectable, Logger } from '@nestjs/common';
import type { MediaJobMessage, MediaMime, UploadTarget } from '@sussurro/shared';

import { Clock } from '../../common/clock/clock.js';
import { describeError } from '../../common/errors/describe-error.js';
import { AppConfig } from '../../config/config.module.js';
import { MediaJobsQueue } from '../../infra/storage/media-jobs-queue.js';
import { MediaUrlSigner, ObjectStorage } from '../../infra/storage/object-storage.js';

const HOUR_MS = 60 * 60 * 1000;
/** URLs assinadas guardadas em memória (uma por objeto e janela de validade). */
const SIGNED_URL_CACHE_SIZE = 20_000;

/** Objeto que o app vai enviar: chave em `incoming/`, tipo e tamanho exatos. */
export interface UploadSpec {
  key: string;
  /** Imagem (foto, poster, avatar) ou vídeo (reel). */
  mime: MediaMime;
  sizeBytes: number;
}

/** Chave privada do upload: `incoming/{userId}/{id}` (ADR 0009). O lifecycle apaga em 1 dia. */
export function incomingKey(userId: string, id: string): string {
  return `incoming/${userId}/${id}`;
}

/** `image/jpeg; charset=…` → `image/jpeg`. */
function baseMime(value: string | undefined): string {
  return (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Pipeline de mídia do lado da API (ADR 0009): URL PUT pré-assinada, conferência do objeto (HEAD),
 * envio para a fila `media-jobs`, URLs de leitura assinadas e remoção de objetos. Regras de quem
 * pode ver ficam no `AccessPolicyService`: esta classe só assina o que já foi autorizado.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly signedUrls = new Map<string, string>();

  constructor(
    private readonly storage: ObjectStorage,
    private readonly signer: MediaUrlSigner,
    private readonly queue: MediaJobsQueue,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /** URL PUT pré-assinada (10 min) com `Content-Type` e `Content-Length` assinados. */
  async uploadTarget(spec: UploadSpec): Promise<UploadTarget> {
    const signingDate = this.clock.now();
    const expiresInS = this.config.env.PRESIGN_PUT_TTL_S;
    const url = await this.storage.presignPut({
      key: spec.key,
      contentType: spec.mime,
      contentLength: spec.sizeBytes,
      expiresInS,
      signingDate,
    });
    return {
      method: 'PUT',
      url,
      headers: { 'Content-Type': spec.mime, 'Content-Length': String(spec.sizeBytes) },
      expiresAt: new Date(signingDate.getTime() + expiresInS * 1000).toISOString(),
    };
  }

  /**
   * O objeto chegou ao S3 com o tamanho e o tipo declarados (ADR 0009, MID-07). Um PUT depois da
   * URL vencer ou maior que o assinado é recusado pelo próprio S3, então o objeto não existe.
   */
  async isUploaded(spec: UploadSpec): Promise<boolean> {
    const head = await this.storage.head(spec.key);
    return (
      head !== null &&
      head.contentLength === spec.sizeBytes &&
      baseMime(head.contentType) === spec.mime
    );
  }

  enqueue(messages: readonly MediaJobMessage[]): Promise<void> {
    return this.queue.send(messages);
  }

  /**
   * Validade das URLs de leitura, em janelas: dentro da mesma janela a URL de um objeto é idêntica
   * (o app e o cache aproveitam) e a assinatura sai do cache. A URL vale de `MEDIA_URL_TTL_S` menos
   * uma janela até `MEDIA_URL_TTL_S` (6 h por padrão, A-19).
   */
  private signingWindow(): { expiresAt: Date; signingDate: Date } {
    const ttlMs = this.config.env.MEDIA_URL_TTL_S * 1000;
    const bucketMs = Math.max(1000, Math.min(HOUR_MS, Math.floor(ttlMs / 6)));
    const expiresAt = Math.floor((this.clock.now().getTime() + ttlMs) / bucketMs) * bucketMs;
    return { expiresAt: new Date(expiresAt), signingDate: new Date(expiresAt - ttlMs) };
  }

  /** URL assinada de leitura, ou `null` sem chave. Só chame depois da política de acesso. */
  async signUrl(key: string | null): Promise<string | null> {
    if (key === null) {
      return null;
    }
    const { expiresAt, signingDate } = this.signingWindow();
    const cacheKey = `${key}|${String(expiresAt.getTime())}`;
    const cached = this.signedUrls.get(cacheKey);
    if (cached !== undefined) {
      // LRU: reinsere para ficar entre os mais recentes.
      this.signedUrls.delete(cacheKey);
      this.signedUrls.set(cacheKey, cached);
      return cached;
    }
    const url = await this.signer.sign(key, expiresAt, signingDate);
    if (this.signedUrls.size >= SIGNED_URL_CACHE_SIZE) {
      const oldest = this.signedUrls.keys().next().value;
      if (oldest !== undefined) {
        this.signedUrls.delete(oldest);
      }
    }
    this.signedUrls.set(cacheKey, url);
    return url;
  }

  deleteObjects(keys: readonly (string | null)[]): Promise<void> {
    const existing = keys.filter((key): key is string => key !== null);
    return existing.length === 0 ? Promise.resolve() : this.storage.deleteObjects(existing);
  }

  /** Remoção que não pode derrubar a requisição: se falhar, o objeto fica para o job do worker. */
  async deleteObjectsQuietly(keys: readonly (string | null)[]): Promise<void> {
    try {
      await this.deleteObjects(keys);
    } catch (error) {
      this.logger.warn(`Falha ao apagar objetos do S3: ${describeError(error)}`);
    }
  }
}
