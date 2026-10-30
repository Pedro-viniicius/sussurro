import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  type AvatarStatus,
  type AvatarUpload,
  type AvatarUploadRequest,
  ErrorCode,
  type ImageMime,
} from '@sussurro/shared';

import { AvatarRepository } from './avatar.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { describeError } from '../../common/errors/describe-error.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { RATE_LIMITS, RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { incomingKey, MediaService } from '../media/media.service.js';

const uploadNotFound = () => new DomainError(ErrorCode.NOT_FOUND, 404, 'Upload não encontrado');

/**
 * Foto de perfil (história 2.4): o mesmo pipeline das fotos de post (URL pré-assinada, HEAD,
 * fila `media-jobs` e o worker removendo os metadados, MID-13). A troca é assíncrona: o app repete
 * o `PUT /me/avatar` até sair de `processing`.
 */
@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  constructor(
    private readonly avatars: AvatarRepository,
    private readonly media: MediaService,
    private readonly rateLimiter: RateLimiterService,
    private readonly clock: Clock,
  ) {}

  /** `POST /me/avatar/upload-url`: reserva o upload e devolve a URL PUT (10 min). */
  async createUploadUrl(viewer: AuthContext, input: AvatarUploadRequest): Promise<AvatarUpload> {
    await this.rateLimiter.consume(RATE_LIMITS.avatarUploadsPerUser, viewer.userId);
    const id = randomUUID();
    const key = incomingKey(viewer.userId, id);
    await this.avatars.insert({
      id,
      userId: viewer.userId,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      incomingKey: key,
      now: this.clock.now(),
    });
    const target = await this.media.uploadTarget({
      key,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
    });
    return { uploadId: id, ...target };
  }

  /**
   * `PUT /me/avatar`: na primeira chamada confere o objeto (HEAD) e envia para o worker; nas
   * seguintes só informa o estado. Upload de outra conta → o mesmo 404 de inexistente.
   */
  async setAvatar(viewer: AuthContext, uploadId: string): Promise<AvatarStatus> {
    const upload = await this.avatars.find(uploadId);
    if (upload?.userId !== viewer.userId) {
      throw uploadNotFound();
    }
    if (upload.status === 'pending_upload') {
      const uploaded = await this.media.isUploaded({
        key: upload.incomingKey,
        mime: upload.mime as ImageMime,
        sizeBytes: upload.sizeBytes,
      });
      if (!uploaded) {
        throw new DomainError(ErrorCode.MEDIA_NOT_UPLOADED, 409, 'A foto não foi enviada');
      }
      const now = this.clock.now();
      if (await this.avatars.markRequested(upload.id, now)) {
        try {
          await this.media.enqueue([{ type: 'avatar', uploadId: upload.id }]);
        } catch (error) {
          this.logger.error(`Falha ao enfileirar o avatar: ${describeError(error)}`);
          await this.avatars.revertToPending(upload.id, now);
          throw new DomainError(
            ErrorCode.SERVICE_UNAVAILABLE,
            503,
            'Processamento indisponível; tente de novo',
          );
        }
      }
      return this.status(viewer.userId, upload.id, 'processing');
    }
    const status =
      upload.status === 'ready' || upload.status === 'failed' ? upload.status : 'processing';
    return this.status(viewer.userId, upload.id, status);
  }

  private async status(
    userId: string,
    uploadId: string,
    status: AvatarStatus['status'],
  ): Promise<AvatarStatus> {
    const avatarKey = await this.avatars.currentAvatarKey(userId);
    return { uploadId, status, avatarUrl: await this.media.signUrl(avatarKey) };
  }

  /** `DELETE /me/avatar`: volta às iniciais; o objeto antigo é apagado (2.4 CA2). */
  async removeAvatar(viewer: AuthContext): Promise<void> {
    const previous = await this.avatars.clearAvatar(viewer.userId, this.clock.now());
    await this.media.deleteObjectsQuietly([previous]);
  }
}
