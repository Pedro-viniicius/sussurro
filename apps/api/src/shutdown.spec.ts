import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerShutdownSignals } from './shutdown.js';

const logger = { log: vi.fn(), error: vi.fn() };

afterEach(() => {
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  vi.clearAllMocks();
});

describe('registerShutdownSignals', () => {
  it('F0-API-07: SIGTERM fecha o app e sai com código 0', async () => {
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    const exit = vi.fn();
    registerShutdownSignals(app, logger, exit);

    process.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith('SIGTERM recebido: desligando');
  });

  it('falha ao fechar sai com código 1', async () => {
    const app = { close: vi.fn().mockRejectedValue(new Error('pool travado')) };
    const exit = vi.fn();
    registerShutdownSignals(app, logger, exit);

    process.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    expect(logger.error).toHaveBeenCalled();
  });
});
