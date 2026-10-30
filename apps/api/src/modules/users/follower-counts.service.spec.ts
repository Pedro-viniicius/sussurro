import { describe, expect, it, vi } from 'vitest';

import {
  FOLLOWERS_CACHE_TTL_MS,
  followersCacheKey,
  FollowerCountsService,
} from './follower-counts.service.js';
import type { UsersRepository } from './users.repository.js';
import type { CounterCache } from '../../common/cache/counter-cache.js';
import { FakeClock } from '../../testing/fake-clock.js';
import { InMemoryCounterCache } from '../../testing/in-memory-counter-cache.js';

function repositoryWith(counts: Record<string, number>) {
  return {
    followerCounts: vi.fn((ids: readonly string[]) =>
      Promise.resolve(new Map(ids.filter((id) => id in counts).map((id) => [id, counts[id]!]))),
    ),
  };
}

describe('FollowerCountsService (CNT-02)', () => {
  it('[CNT-02] conta no banco na primeira vez e serve do cache por 60 s', async () => {
    const clock = new FakeClock();
    const repository = repositoryWith({ a: 3, b: 0 });
    const service = new FollowerCountsService(
      repository as unknown as UsersRepository,
      new InMemoryCounterCache(clock),
    );
    expect(await service.followersOf(['a', 'b', 'c'])).toEqual(
      new Map([
        ['a', 3],
        ['b', 0],
        ['c', 0],
      ]),
    );
    repository.followerCounts.mockClear();

    clock.advance(FOLLOWERS_CACHE_TTL_MS - 1);
    expect(await service.followersOfOne('a')).toBe(3);
    expect(repository.followerCounts).not.toHaveBeenCalled();

    clock.advance(1);
    expect(await service.followersOfOne('a')).toBe(3);
    expect(repository.followerCounts).toHaveBeenCalledWith(['a']);
  });

  it('R11: cache com erro ou lento → conta no banco e responde do mesmo jeito', async () => {
    const repository = repositoryWith({ a: 5 });
    const broken: CounterCache = {
      getMany: () => Promise.reject(new Error('ECONNREFUSED')),
      setMany: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const service = new FollowerCountsService(repository as unknown as UsersRepository, broken);
    await expect(service.followersOfOne('a')).resolves.toBe(5);
  });

  it('chave por criador, sem dado pessoal', () => {
    expect(followersCacheKey('01a189e0-af57-7000-85fe-2054e618fea6')).toBe(
      'cnt:followers:01a189e0-af57-7000-85fe-2054e618fea6',
    );
  });
});
