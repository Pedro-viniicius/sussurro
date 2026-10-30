import { Body, Controller, Delete, Header, HttpCode, Post, Put } from '@nestjs/common';
import {
  type AvatarStatus,
  AvatarStatusSchema,
  type AvatarUpload,
  type AvatarUploadRequest,
  AvatarUploadRequestSchema,
  AvatarUploadSchema,
  NoContentSchema,
  type SetAvatarRequest,
  SetAvatarRequestSchema,
} from '@sussurro/shared';

import { AvatarService } from './avatar.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/**
 * Foto de perfil (história 2.4, arquitetura.md §13). Liberada sem e-mail confirmado: perfil e
 * conta não entram no bloqueio parcial (X.3).
 */
@Controller('me/avatar')
export class AvatarController {
  constructor(private readonly avatars: AvatarService) {}

  @Post('upload-url')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(AvatarUploadSchema)
  createUploadUrl(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(AvatarUploadRequestSchema)) body: AvatarUploadRequest,
  ): Promise<AvatarUpload> {
    return this.avatars.createUploadUrl(auth, body);
  }

  @Put()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(AvatarStatusSchema)
  setAvatar(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(SetAvatarRequestSchema)) body: SetAvatarRequest,
  ): Promise<AvatarStatus> {
    return this.avatars.setAvatar(auth, body.uploadId);
  }

  @Delete()
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  removeAvatar(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.avatars.removeAvatar(auth);
  }
}
