import { describe, expect, it, vi } from 'vitest';

import { createDb, InvalidDatabaseUrlError, parseDatabaseUrl } from './client.ts';

const URL_OK = 'postgres://sussurro:segredo@localhost:5432/sussurro';

describe('parseDatabaseUrl', () => {
  it('aceita postgres:// e postgresql://', () => {
    expect(parseDatabaseUrl(URL_OK).hostname).toBe('localhost');
    expect(parseDatabaseUrl('postgresql://u:p@db:5432/app').pathname).toBe('/app');
  });

  it.each([
    ['', 'vazia'],
    ['nao-e-url', 'não é uma URL'],
    ['mysql://u:p@localhost:3306/app', 'protocolo'],
    ['postgres://u:p@localhost:5432', 'sem nome do banco'],
  ])('rejeita %j com mensagem clara (%s)', (url, trecho) => {
    expect(() => parseDatabaseUrl(url)).toThrow(InvalidDatabaseUrlError);
    expect(() => parseDatabaseUrl(url)).toThrow(trecho);
  });

  it('não expõe a senha na mensagem de erro', () => {
    try {
      parseDatabaseUrl('mysql://u:senha-secreta@localhost/app');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('senha-secreta');
    }
  });
});

describe('createDb', () => {
  it('aplica os padrões do pool sem abrir conexão', async () => {
    const handle = createDb(URL_OK);
    expect(handle.pool.options.max).toBe(10);
    expect(handle.pool.options.connectionTimeoutMillis).toBe(1_000);
    expect(handle.pool.options.idleTimeoutMillis).toBe(30_000);
    expect(handle.pool.options.application_name).toBe('sussurro');
    expect(handle.pool.totalCount).toBe(0);
    await handle.close();
  });

  it('aceita opções e registra o handler de erro de conexões ociosas', async () => {
    const onIdleError = vi.fn();
    const handle = createDb(URL_OK, { max: 2, applicationName: 'sussurro-api', onIdleError });
    expect(handle.pool.options.max).toBe(2);
    expect(handle.pool.options.application_name).toBe('sussurro-api');

    const error = new Error('conexão encerrada');
    handle.pool.emit('error', error);
    expect(onIdleError).toHaveBeenCalledWith(error);
    await handle.close();
  });

  it('close() pode ser chamado mais de uma vez', async () => {
    const handle = createDb(URL_OK);
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('falha com URL inválida', () => {
    expect(() => createDb('http://localhost/x')).toThrow(InvalidDatabaseUrlError);
  });
});
