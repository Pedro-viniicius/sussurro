import { Injectable } from '@nestjs/common';
import {
  ErrorCode,
  isValidHandleFormat,
  type Me,
  normalizeHandle,
  type PublicProfile,
  type UpdateMeRequest,
} from '@sussurro/shared';

import { FollowerCountsService } from './follower-counts.service.js';
import {
  type ProfileCountValues,
  type ProfileRow,
  toMe,
  toPublicProfile,
} from './profile.mapper.js';
import { type ProfileChanges, UsersRepository } from './users.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { MediaService } from '../media/media.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';

/**
 * O mesmo 404 para @ inexistente, conta excluída e perfil pessoal sem permissão: o corpo não
 * revela se a conta existe (PERM-13).
 */
export function profileNotFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, 404, 'Perfil não encontrado');
}

@Injectable()
export class UsersService {
  constructor(
    private readonly users: UsersRepository,
    private readonly followerCounts: FollowerCountsService,
    private readonly policy: AccessPolicyService,
    private readonly media: MediaService,
    private readonly clock: Clock,
  ) {}

  /** Números do perfil; seguidores (só criador) pelo cache de 60 s (CNT-02). */
  private async countsOf(row: ProfileRow): Promise<ProfileCountValues> {
    const [counts, followers] = await Promise.all([
      this.users.counts(row.id),
      row.accountType === 'creator'
        ? this.followerCounts.followersOfOne(row.id)
        : Promise.resolve(0),
    ]);
    return { ...counts, followers };
  }

  private async me(row: ProfileRow): Promise<Me> {
    const [counts, avatarUrl] = await Promise.all([
      this.countsOf(row),
      this.media.signUrl(row.avatarKey),
    ]);
    return toMe(row, counts, avatarUrl);
  }

  async getMe(userId: string): Promise<Me> {
    const row = await this.users.findActiveById(userId);
    if (row === undefined) {
      throw profileNotFound();
    }
    return this.me(row);
  }

  /** Só nome e bio (PERM-07: o schema `strict` já recusou qualquer outro campo). */
  async updateMe(userId: string, input: UpdateMeRequest): Promise<Me> {
    const changes: ProfileChanges = {};
    if (input.name !== undefined) {
      changes.name = input.name;
    }
    if (input.bio !== undefined) {
      changes.bio = input.bio;
    }
    if (Object.keys(changes).length === 0) {
      return this.getMe(userId);
    }
    const row = await this.users.updateProfile(userId, changes, this.clock.now());
    if (row === undefined) {
      throw profileNotFound();
    }
    return this.me(row);
  }

  /**
   * Conta ativa pelo @ (normalizado), **sem regra de visibilidade**: quem chama decide pelo
   * `AccessPolicyService` (seguir, bloquear, denunciar) e responde o 404 padrão. @ com formato
   * inválido → `undefined`, como inexistente.
   */
  async findActiveAccount(rawHandle: string): Promise<ProfileRow | undefined> {
    const handle = normalizeHandle(rawHandle);
    if (!isValidHandleFormat(handle)) {
      return undefined;
    }
    return this.users.findActiveByHandle(handle);
  }

  /**
   * Conta ativa pelo id, **sem regra de visibilidade** (Fase 4: o dono de um token de proximidade).
   * Quem chama decide pelo `AccessPolicyService`.
   */
  findActiveAccountById(id: string): Promise<ProfileRow | undefined> {
    return this.users.findActiveById(id);
  }

  /**
   * Conta pelo @, se o leitor pode ver o perfil (arquitetura §7.3): criador para todos; pessoal só
   * para o dono e as conexões; com bloqueio em qualquer sentido, ninguém (X.2). Qualquer outro caso
   * é o mesmo 404 (PERM-13). Usado também pelas abas do perfil (`GET /users/:handle/posts`), para
   * as duas rotas responderem igual.
   */
  async findVisibleProfile(viewer: AuthContext, rawHandle: string): Promise<ProfileRow> {
    const row = await this.findActiveAccount(rawHandle);
    if (row === undefined || !(await this.policy.canViewProfile(viewer, row))) {
      throw profileNotFound();
    }
    return row;
  }

  /** `GET /users/:handle` com as regras de visibilidade da arquitetura §7. */
  async getProfile(viewer: AuthContext, rawHandle: string): Promise<PublicProfile> {
    const row = await this.findVisibleProfile(viewer, rawHandle);
    const [counts, avatarUrl, followedByMe] = await Promise.all([
      this.countsOf(row),
      this.media.signUrl(row.avatarKey),
      row.accountType === 'creator'
        ? this.policy.isFollowing(viewer, row.id)
        : Promise.resolve(false),
    ]);
    return toPublicProfile(row, counts, avatarUrl, followedByMe);
  }
}
