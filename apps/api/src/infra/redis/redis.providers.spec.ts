import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeRedisClient, createRedisClient } from './redis.providers.js';

const logger = { warn: vi.fn(), log: vi.fn() };

afterEach(() => {
  vi.clearAllMocks();
});

describe('createRedisClient', () => {
  it('é preguiçoso: não conecta ao ser criado', async () => {
    const client = createRedisClient('redis://localhost:6379/15', logger);
    expect(client.status).toBe('wait');
    await closeRedisClient(client);
  });

  it('registra só a transição caiu/voltou, sem inundar o log', async () => {
    const client = createRedisClient('redis://localhost:6379/15', logger);
    const refused = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    client.emit('error', refused);
    client.emit('error', refused);
    client.emit('error', refused);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Redis indisponível: ECONNREFUSED');

    client.emit('ready');
    expect(logger.log).toHaveBeenCalledWith('Redis disponível de novo');
    await closeRedisClient(client);
  });
});

describe('closeRedisClient', () => {
  it('usa QUIT quando conectado e disconnect() nos outros casos', async () => {
    const ready = { status: 'ready', quit: vi.fn().mockResolvedValue('OK'), disconnect: vi.fn() };
    await closeRedisClient(ready as never);
    expect(ready.quit).toHaveBeenCalled();
    expect(ready.disconnect).not.toHaveBeenCalled();

    const reconnecting = { status: 'reconnecting', quit: vi.fn(), disconnect: vi.fn() };
    await closeRedisClient(reconnecting as never);
    expect(reconnecting.quit).not.toHaveBeenCalled();
    expect(reconnecting.disconnect).toHaveBeenCalled();
  });
});
