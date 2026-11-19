import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadApiEnv } from './env.schema.js';

const base = {
  DATABASE_URL: 'postgres://sussurro:sussurro@localhost:5432/sussurro',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(43),
};

describe('loadApiEnv', () => {
  it('aplica os padrões', () => {
    const env = loadApiEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_HOST: '0.0.0.0',
      API_PORT: 3000,
      SENTRY_ENVIRONMENT: 'local',
      SENTRY_TRACES_SAMPLE_RATE: 0,
    });
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('converte API_PORT para número', () => {
    expect(loadApiEnv({ ...base, API_PORT: '8080' }).API_PORT).toBe(8080);
  });

  it('F0-API-06: sem DATABASE_URL falha citando a variável', () => {
    const { DATABASE_URL: _omit, ...withoutDatabase } = base;
    expect(() => loadApiEnv(withoutDatabase)).toThrow(EnvValidationError);
    expect(() => loadApiEnv(withoutDatabase)).toThrow(/DATABASE_URL: obrigatória/);
  });

  it('DATABASE_URL vazia conta como ausente', () => {
    expect(() => loadApiEnv({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL: obrigatória/);
  });

  it('rejeita protocolo errado e porta fora do intervalo, citando cada variável', () => {
    try {
      loadApiEnv({
        ...base,
        DATABASE_URL: 'mysql://x@localhost/db',
        REDIS_URL: 'http://x',
        API_PORT: '70000',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const { issues } = error as EnvValidationError;
      expect(issues.some((i) => i.startsWith('DATABASE_URL: inválida'))).toBe(true);
      expect(issues.some((i) => i.startsWith('REDIS_URL: inválida'))).toBe(true);
      expect(issues.some((i) => i.startsWith('API_PORT'))).toBe(true);
    }
  });

  it('SENTRY_DSN vazio desliga o Sentry; preenchido precisa ser URL', () => {
    expect(loadApiEnv({ ...base, SENTRY_DSN: '' }).SENTRY_DSN).toBeUndefined();
    expect(() => loadApiEnv({ ...base, SENTRY_DSN: 'nao-e-url' })).toThrow(/SENTRY_DSN/);
  });

  it('A-27: TTLs de auth vêm do env, com os padrões do ADR 0007', () => {
    const env = loadApiEnv(base);
    expect(env).toMatchObject({
      ACCESS_TOKEN_TTL_S: 900,
      REFRESH_TOKEN_TTL_S: 2_592_000,
      REFRESH_REUSE_GRACE_S: 20,
      EMAIL_VERIFICATION_TTL_S: 86_400,
      PASSWORD_RESET_TTL_S: 3_600,
      JWT_ACCESS_KID: 'k1',
      EMAIL_SENDER: 'log',
      EMAIL_LINK_BASE_URL: 'sussurro://',
      TRUST_PROXY_HOPS: 0,
    });
    expect(loadApiEnv({ ...base, ACCESS_TOKEN_TTL_S: '60' }).ACCESS_TOKEN_TTL_S).toBe(60);
  });

  it('JWT_ACCESS_SECRET é obrigatório e precisa de 32+ caracteres', () => {
    const { JWT_ACCESS_SECRET: _omit, ...withoutSecret } = base;
    expect(() => loadApiEnv(withoutSecret)).toThrow(/JWT_ACCESS_SECRET: obrigatória/);
    expect(() => loadApiEnv({ ...base, JWT_ACCESS_SECRET: 'curto' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('segredo anterior do JWT exige o kid anterior, diferente do atual', () => {
    expect(() => loadApiEnv({ ...base, JWT_ACCESS_PREVIOUS_SECRET: 'y'.repeat(43) })).toThrow(
      /JWT_ACCESS_PREVIOUS_KID/,
    );
    expect(() =>
      loadApiEnv({
        ...base,
        JWT_ACCESS_PREVIOUS_SECRET: 'y'.repeat(43),
        JWT_ACCESS_PREVIOUS_KID: 'k1',
      }),
    ).toThrow(/diferente/);
    expect(
      loadApiEnv({
        ...base,
        JWT_ACCESS_PREVIOUS_SECRET: 'y'.repeat(43),
        JWT_ACCESS_PREVIOUS_KID: 'k0',
      }).JWT_ACCESS_PREVIOUS_KID,
    ).toBe('k0');
  });

  it('D6: em produção o e-mail precisa ser SES (o adaptador de log vaza os links)', () => {
    expect(() => loadApiEnv({ ...base, NODE_ENV: 'production' })).toThrow(/EMAIL_SENDER/);
    // Fase 2: produção também exige a mídia pelo CloudFront (env.media.spec.ts).
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const production = {
      ...base,
      NODE_ENV: 'production',
      MEDIA_URL_SIGNER: 'cloudfront',
      CLOUDFRONT_DOMAIN: 'media.sussurro.app',
      CLOUDFRONT_KEY_PAIR_ID: 'K123',
      CLOUDFRONT_PRIVATE_KEY: privateKey,
    };
    expect(() => loadApiEnv(production)).toThrow(/EMAIL_SENDER/);
    // Fase 3: produção também exige o e-mail da moderação (X.1).
    expect(() => loadApiEnv({ ...production, EMAIL_SENDER: 'ses' })).toThrow(/MODERATION_EMAIL/);
    expect(
      loadApiEnv({ ...production, EMAIL_SENDER: 'ses', MODERATION_EMAIL: 'moderacao@sussurro.app' })
        .EMAIL_SENDER,
    ).toBe('ses');
  });

  it('X.1: MODERATION_EMAIL vazia fora de produção fica ausente; preenchida precisa ser e-mail', () => {
    expect(loadApiEnv({ ...base, MODERATION_EMAIL: '' }).MODERATION_EMAIL).toBeUndefined();
    expect(loadApiEnv({ ...base, MODERATION_EMAIL: 'mod@sussurro.app' }).MODERATION_EMAIL).toBe(
      'mod@sussurro.app',
    );
    expect(() => loadApiEnv({ ...base, MODERATION_EMAIL: 'nao-e-email' })).toThrow(
      /MODERATION_EMAIL/,
    );
  });

  it('Fase 4 (A-27): tempos da proximidade com os padrões do ADR 0003; "memory" nunca em produção', () => {
    expect(loadApiEnv(base)).toMatchObject({
      PROX_TOKEN_TTL_S: 30,
      PROX_RECENT_TTL_S: 120,
      PROX_SCREEN_TTL_S: 30,
      CONNECTION_REQUEST_TTL_S: 120,
      CONNECTION_DECLINE_COOLDOWN_S: 3600,
      PROXIMITY_STORE: 'redis',
    });
    expect(loadApiEnv({ ...base, PROXIMITY_STORE: 'memory' }).PROXIMITY_STORE).toBe('memory');
    expect(() => loadApiEnv({ ...base, PROXIMITY_STORE: 'arquivo' })).toThrow(/PROXIMITY_STORE/);
    expect(() =>
      loadApiEnv({ ...base, NODE_ENV: 'production', PROXIMITY_STORE: 'memory' }),
    ).toThrow(/PROXIMITY_STORE: em produção use "redis"/);
    expect(() => loadApiEnv({ ...base, PROX_TOKEN_TTL_S: '60', PROX_RECENT_TTL_S: '30' })).toThrow(
      /PROX_RECENT_TTL_S/,
    );
  });

  it('[PROX-47] ADR 0013: os env do encosto (PROX_TOUCH_*) saíram e não entram no env carregado', () => {
    const env = loadApiEnv({ ...base, PROX_TOUCH_WINDOW_S: '5', PROX_TOUCH_PAIR_TTL_S: '60' });
    expect(Object.keys(env).filter((name) => name.startsWith('PROX_TOUCH'))).toEqual([]);
  });
});
