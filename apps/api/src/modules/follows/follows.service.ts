import { Injectable } from '@nestjs/common';
import { users } from '@sussurro/db';
import {
  CREATOR_SEARCH_MAX_RESULTS,
  type CreatorSearchResult,
  type FollowState,
} from '@sussurro/shared';

import { FollowsRepository } from './follows.repository.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { lockAccountPair } from '../../common/db/pair-lock.js';
import { RATE_LIMITS, RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { MediaService } from '../media/media.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';
import { FollowerCountsService } from '../users/follower-counts.service.js';
import type { ProfileRow } from '../users/profile.mapper.js';
import { profileNotFound, UsersService } from '../users/users.service.js';

/**
 * Busca de criadores (3.1, 3.2), seguir e deixar de seguir (3.3). As rotas são só de conta pessoal
 * (`@RequireAccountType('personal')`, PERM-05); a regra de quem pode seguir quem fica no
 * `AccessPolicyService` (tipo das duas contas e bloqueio, X.2).
 */
@Injectable()
export class FollowsService {
  constructor(
    private readonly follows: FollowsRepository,
    private readonly users: UsersService,
    private readonly followerCounts: FollowerCountsService,
    private readonly policy: AccessPolicyService,
    private readonly media: MediaService,
    private readonly rateLimiter: RateLimiterService,
    private readonly notifications: NotificationsService,
    private readonly clock: Clock,
  ) {}

  /**
   * `GET /search/creators?q=`: até 20 criadores com o prefixo, em ordem alfabética (BUS-04,
   * BUS-07). Sem criador, `items: []`, igual para @ pessoal e @ inexistente (A-04, BUS-05).
   */
  async search(viewer: AuthContext, prefix: string): Promise<CreatorSearchResult> {
    await this.rateLimiter.consume(RATE_LIMITS.searchPerUser, viewer.userId);
    const rows = await this.follows.searchCreators(
      viewer.userId,
      prefix,
      CREATOR_SEARCH_MAX_RESULTS,
      this.policy.hideBlockedFor(viewer, users.id),
    );
    const followers = await this.followerCounts.followersOf(rows.map((row) => row.id));
    return {
      items: await Promise.all(
        rows.map(async (row) => ({
          handle: row.handle,
          name: row.name,
          avatarUrl: await this.media.signUrl(row.avatarKey),
          followersCount: followers.get(row.id) ?? 0,
          followedByMe: row.followedByMe,
        })),
      ),
    };
  }

  /**
   * `PUT /creators/:handle/follow` (idempotente, PERM-04). Rate limit de 10 por minuto, somado com
   * o de deixar de seguir (3.3 CA5), contado antes de procurar o @. @ inexistente, de conta
   * pessoal ou com bloqueio em qualquer sentido → o mesmo 404 de perfil (PERM-03, X.2 CA2).
   */
  async follow(viewer: AuthContext, rawHandle: string): Promise<FollowState> {
    await this.rateLimiter.consume(RATE_LIMITS.followsPerUser, viewer.userId);
    const creator = await this.users.findActiveAccount(rawHandle);
    if (creator === undefined) {
      throw profileNotFound();
    }
    const outcome = await this.follows.db.transaction(async (tx) => {
      // Mesma trava do bloqueio: um follow concorrente nunca sobrevive a ele.
      await lockAccountPair(tx, viewer.userId, creator.id);
      if (!(await this.policy.canFollow(viewer, creator, tx))) {
        return undefined;
      }
      const now = this.clock.now();
      const added = await this.follows.follow(tx, viewer.userId, creator.id, now);
      // Fase 6 (6.3): o follow novo soma 1 na notificação de seguidores do dia, anônima, na mesma
      // transação. Seguir de novo (idempotente) não soma.
      return added
        ? await this.notifications.recordNewFollower(tx, { creatorId: creator.id, now })
        : [];
    });
    if (outcome === undefined) {
      throw profileNotFound();
    }
    await this.notifications.dispatch(outcome);
    return { following: true };
  }

  /** `DELETE /creators/:handle/follow` (idempotente): o mesmo 404 de `follow` para quem não pode. */
  async unfollow(viewer: AuthContext, rawHandle: string): Promise<FollowState> {
    await this.rateLimiter.consume(RATE_LIMITS.followsPerUser, viewer.userId);
    const creator = await this.followableCreator(viewer, rawHandle);
    await this.follows.unfollow(viewer.userId, creator.id);
    return { following: false };
  }

  private async followableCreator(viewer: AuthContext, rawHandle: string): Promise<ProfileRow> {
    const creator = await this.users.findActiveAccount(rawHandle);
    if (creator === undefined || !(await this.policy.canFollow(viewer, creator))) {
      throw profileNotFound();
    }
    return creator;
  }
}
