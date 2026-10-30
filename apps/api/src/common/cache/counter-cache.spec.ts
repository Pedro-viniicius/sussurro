import { describe, expect, it, vi } from 'vitest';

import { RedisCounterCache } from './counter-cache.js';
import { FakeClock } from '../../testing/fake-clock.js';
import { InMemoryCounterCache } from '../../testing/in-memory-counter-cache.js';

describe('RedisCounterCache', () => {
  it('MGET devolve os números na ordem das chaves; ausente ou lixo vira null', async () => {
    const mget = vi.fn().mockResolvedValue(['12', null, 'abc', '-1']);
    const cache = new RedisCounterCache({ mget, multi: vi.fn() });
    await expect(cache.getMany(['a', 'b', 'c', 'd'])).resolves.toEqual([12, null, null, null]);
    expect(mget).toHaveBeenCalledWith('a', 'b', 'c', 'd');
    await expect(cache.getMany([])).resolves.toEqual([]);
    expect(mget).toHaveBeenCalledTimes(1);
  });

  it('grava cada chave com SET PX numa transação MULTI', async () => {
    const set = vi.fn();
    const exec = vi.fn().mockResolvedValue([]);
    const multi = vi.fn(() => ({ set, exec }));
    const cache = new RedisCounterCache({ mget: vi.fn(), multi } as never);
    await cache.setMany(
      [
        { key: 'a', value: 1 },
        { key: 'b', value: 0 },
      ],
      60_000,
    );
    expect(set).toHaveBeenNthCalledWith(1, 'a', '1', 'PX', 60_000);
    expect(set).toHaveBeenNthCalledWith(2, 'b', '0', 'PX', 60_000);
    expect(exec).toHaveBeenCalledTimes(1);
    await cache.setMany([], 60_000);
    expect(multi).toHaveBeenCalledTimes(1);
  });
});

describe('InMemoryCounterCache (fake dos testes)', () => {
  it('vale até o TTL pelo relógio injetado', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCounterCache(clock);
    await cache.setMany([{ key: 'a', value: 7 }], 60_000);
    clock.advance(59_999);
    await expect(cache.getMany(['a', 'b'])).resolves.toEqual([7, null]);
    clock.advance(1);
    await expect(cache.getMany(['a'])).resolves.toEqual([null]);
  });
});
