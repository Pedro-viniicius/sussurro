import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post as HttpPost,
  Query,
} from '@nestjs/common';
import {
  type CreateDraftRequest,
  CreateDraftRequestSchema,
  type CreateTextPostRequest,
  CreateTextPostRequestSchema,
  type Draft,
  DraftSchema,
  NoContentSchema,
  type Post,
  PostSchema,
  type ProfilePostsPage,
  ProfilePostsPageSchema,
  type ProfilePostsQuery,
  ProfilePostsQuerySchema,
  type PublishPostRequest,
  PublishPostRequestSchema,
} from '@sussurro/shared';

import { PostsService } from './posts.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth, RequireVerifiedEmail } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/**
 * Publicações (histórias 2.1, 2.2 e 2.9; arquitetura.md §9 e §13). Pessoal e criador publicam;
 * criar e publicar exigem e-mail confirmado (X.3). Respostas com URLs assinadas: sem cache.
 */
@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @HttpPost()
  @HttpCode(201)
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(PostSchema)
  createTextPost(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateTextPostRequestSchema)) body: CreateTextPostRequest,
  ): Promise<Post> {
    return this.posts.createTextPost(auth, body);
  }

  @HttpPost('drafts')
  @HttpCode(201)
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(DraftSchema)
  createDraft(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateDraftRequestSchema)) body: CreateDraftRequest,
  ): Promise<Draft> {
    return this.posts.createDraft(auth, body);
  }

  @HttpPost(':id/publish')
  @HttpCode(200)
  @RequireVerifiedEmail()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(PostSchema)
  publish(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PublishPostRequestSchema)) body: PublishPostRequest,
  ): Promise<Post> {
    return this.posts.publish(auth, id, body);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(PostSchema)
  getPost(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<Post> {
    return this.posts.getPost(auth, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ResponseSchema(NoContentSchema)
  deletePost(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.posts.deletePost(auth, id);
  }
}

/** Abas do perfil (história 2.6): `GET /users/:handle/posts?type=&cursor=&limit=`. */
@Controller('users')
export class UserPostsController {
  constructor(private readonly posts: PostsService) {}

  @Get(':handle/posts')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(ProfilePostsPageSchema)
  listProfilePosts(
    @CurrentAuth() auth: AuthContext,
    @Param('handle') handle: string,
    @Query(new ZodValidationPipe(ProfilePostsQuerySchema)) query: ProfilePostsQuery,
  ): Promise<ProfilePostsPage> {
    return this.posts.listProfilePosts(auth, handle, query);
  }
}
