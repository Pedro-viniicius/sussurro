import { Injectable, Logger } from '@nestjs/common';

import { UsersRepository } from './users.repository.js';
import { withTimeout } from '../../common/async/with-timeout.js';
import { CounterCache } from '../../common/cache/counter-cache.js';
import { describeError } from '../../common/errors/describe-error.js';

/** Validade do número de seguidores no cache (ADR 0004, arquitetura.md §8, CNT-02). */
export const FOLLOWERS_CACHE_TTL_MS = 60_000;

/** Tempo máximo esperando o Redis antes de contar no banco (fail-open, R11). */
const CACHE_TIMEOUT_MS = 250;

export function followersCacheKey(creatorId: string): string {
  return `cnt:followers:${creatorId}`;
}

/**
 * Número de seguidores de criadores (perfil, `GET /me` do criador e busca), com cache de 60 s no
 * Redis: o `COUNT(*)` de um criador com muitos seguidores não roda a cada visita. Seguir, deixar de
 * seguir, bloquear e excluir a conta aparecem em até 60 s (CNT-02); o contador "criadores" de quem
 * segue não tem cache e muda na hora. Sem Redis, conta no banco (nunca falha por causa do cache).
 * Só números: não existe lista de seguidores, nem para o próprio criador (ADR 0004, PERM-09).
 */
@Injectable()
export class FollowerCountsService {
  private readonly logger = new Logger(FollowerCountsService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly cache: CounterCache,
  ) {}

  async followersOf(creatorIds: readonly string[]): Promise<Map<string, number>> {
    const ids = [...new Set(creatorIds)];
    const counts = new Map<string, number>();
    if (ids.length === 0) {
      return counts;
    }
    const cached = await this.readCache(ids);
    const missing: string[] = [];
    ids.forEach((id, index) => {
      const value = cached[index];
      if (value === null || value === undefined) {
        missing.push(id);
      } else {
        counts.set(id, value);
      }
    });
    if (missing.length > 0) {
      const fresh = await this.users.followerCounts(missing);
      for (const id of missing) {
        counts.set(id, fresh.get(id) ?? 0);
      }
      await this.writeCache(missing.map((id) => ({ id, value: counts.get(id) ?? 0 })));
    }
    return counts;
  }

  async followersOfOne(creatorId: string): Promise<number> {
    return (await this.followersOf([creatorId])).get(creatorId) ?? 0;
  }

  private async readCache(ids: readonly string[]): Promise<(number | null)[]> {
    try {
      return await withTimeout(this.cache.getMany(ids.map(followersCacheKey)), CACHE_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(
        `Cache de seguidores indisponível (contando no banco): ${describeError(error)}`,
      );
      return ids.map(() => null);
    }
  }

  private async writeCache(entries: readonly { id: string; value: number }[]): Promise<void> {
    try {
      await withTimeout(
        this.cache.setMany(
          entries.map((entry) => ({ key: followersCacheKey(entry.id), value: entry.value })),
          FOLLOWERS_CACHE_TTL_MS,
        ),
        CACHE_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger.warn(`Falha ao gravar o cache de seguidores: ${describeError(error)}`);
    }
  }
}
