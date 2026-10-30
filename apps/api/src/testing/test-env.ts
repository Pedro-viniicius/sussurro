import { generateKeyPairSync } from 'node:crypto';

import { vi } from 'vitest';

import { loadApiEnv, type ApiEnv } from '../config/env.schema.js';

/** Segredo HMAC só de teste (32+ caracteres). */
export const TEST_JWT_SECRET = 'segredo-de-teste-do-jwt-com-mais-de-32-caracteres'; // gitleaks:allow (fictício, só de teste)

/** Ambiente mínimo e válido para testes unitários (nenhuma conexão real é aberta). */
export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  return loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://sussurro:sussurro@localhost:5432/sussurro_unit',
    REDIS_URL: 'redis://localhost:6379/15',
    JWT_ACCESS_SECRET: TEST_JWT_SECRET,
    ...overrides,
  });
}

/** Domínio e key pair fictícios do CloudFront nos testes. */
export const TEST_CLOUDFRONT_DOMAIN = 'media.sussurro.teste';
export const TEST_CLOUDFRONT_KEY_PAIR_ID = 'K2TESTESUSSURRO';

let cloudFrontKeys: { privateKey: string; publicKey: string } | undefined;

/**
 * Par de chaves RSA local, gerado no próprio teste (nada é baixado): o "assinador e chave locais"
 * das URLs no formato do CloudFront. A pública verifica as assinaturas nos testes (PERM-16).
 */
export function testCloudFrontKeys(): { privateKey: string; publicKey: string } {
  cloudFrontKeys ??= generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return cloudFrontKeys;
}

/** Variáveis para a API assinar a mídia no formato do CloudFront com a chave local. */
export function cloudFrontTestEnv(): Record<string, string> {
  return {
    MEDIA_URL_SIGNER: 'cloudfront',
    CLOUDFRONT_DOMAIN: TEST_CLOUDFRONT_DOMAIN,
    CLOUDFRONT_KEY_PAIR_ID: TEST_CLOUDFRONT_KEY_PAIR_ID,
    CLOUDFRONT_PRIVATE_KEY: testCloudFrontKeys().privateKey,
  };
}

/** Dublês do DbHandle e do cliente Redis, controláveis por teste. */
export function fakeDependencies() {
  const database = {
    db: { execute: vi.fn<() => Promise<unknown>>().mockResolvedValue({ rows: [{ ok: 1 }] }) },
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const redis = {
    ping: vi.fn<() => Promise<string>>().mockResolvedValue('PONG'),
    status: 'ready',
    quit: vi.fn<() => Promise<string>>().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  };
  return { database, redis };
}
