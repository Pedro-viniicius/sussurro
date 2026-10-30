import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  type Comment,
  CommentSchema,
  type CommentsPage,
  CommentsPageSchema,
  type CommentsQuery,
  CommentsQuerySchema,
  type CreateCommentRequest,
  CreateCommentRequestSchema,
  NoContentSchema,
} from '@sussurro/shared';

import { CommentsService } from './comments.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth, RequireVerifiedEmail } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/** Comentários de um post (história 2.8). Comentar exige e-mail confirmado (X.3). */
@Controller('posts')
export class PostCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get(':id/comments')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(CommentsPageSchema)
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(CommentsQuerySchema)) query: CommentsQuery,
  ): Promise<CommentsPage> {
    return this.comments.list(auth, id, query);
  }

  @Post(':id/comments')
  @HttpCode(201)
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(CommentSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateCommentRequestSchema)) body: CreateCommentRequest,
  ): Promise<Comment> {
    return this.comments.create(auth, id, body);
  }
}

/** `DELETE /comments/:id`: autor do comentário ou do post (2.8 CA4). */
@Controller('comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Delete(':id')
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  delete(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.comments.delete(auth, id);
  }
}
