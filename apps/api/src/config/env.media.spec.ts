import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadApiEnv } from './env.schema.js';

const base = {
  DATABASE_URL: 'postgres://sussurro:sussurro@localhost:5432/sussurro',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(43),
};

describe('loadApiEnv: feed e mídia (Fase 2)', () => {
  it('[FEED-03b] FEED_WINDOW_HOURS ausente = 72; 1 e 720 aceitos', () => {
    expect(loadApiEnv(base).FEED_WINDOW_HOURS).toBe(72);
    expect(loadApiEnv({ ...base, FEED_WINDOW_HOURS: '1' }).FEED_WINDOW_HOURS).toBe(1);
    expect(loadApiEnv({ ...base, FEED_WINDOW_HOURS: ' 24 ' }).FEED_WINDOW_HOURS).toBe(24);
    expect(loadApiEnv({ ...base, FEED_WINDOW_HOURS: '720' }).FEED_WINDOW_HOURS).toBe(720);
  });

  it.each([['0'], ['-1'], ['abc'], [''], ['   '], ['1.5'], ['721'], ['72h']])(
    '[FEED-03b] FEED_WINDOW_HOURS=%j impede a API de subir',
    (value) => {
      expect(() => loadApiEnv({ ...base, FEED_WINDOW_HOURS: value })).toThrow(EnvValidationError);
      expect(() => loadApiEnv({ ...base, FEED_WINDOW_HOURS: value })).toThrow(
        /FEED_WINDOW_HOURS: inválida/,
      );
    },
  );

  it('padrões de mídia: s3-presign em dev, PUT de 10 min, leitura de 6 h, bucket e fila', () => {
    expect(loadApiEnv(base)).toMatchObject({
      MEDIA_URL_SIGNER: 's3-presign',
      PRESIGN_PUT_TTL_S: 600,
      MEDIA_URL_TTL_S: 21_600,
      S3_BUCKET_MEDIA: 'sussurro-media',
      SQS_QUEUE_MEDIA_JOBS: 'media-jobs',
      S3_FORCE_PATH_STYLE: false,
    });
    expect(loadApiEnv({ ...base, S3_FORCE_PATH_STYLE: 'true' }).S3_FORCE_PATH_STYLE).toBe(true);
    expect(loadApiEnv({ ...base, AWS_ENDPOINT_URL_S3: '' }).AWS_ENDPOINT_URL_S3).toBeUndefined();
  });

  it('MEDIA_URL_SIGNER=cloudfront exige domínio, key pair e chave privada em PEM', () => {
    expect(() => loadApiEnv({ ...base, MEDIA_URL_SIGNER: 'cloudfront' })).toThrow(
      /CLOUDFRONT_DOMAIN: obrigatória com MEDIA_URL_SIGNER=cloudfront/,
    );
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const env = loadApiEnv({
      ...base,
      MEDIA_URL_SIGNER: 'cloudfront',
      CLOUDFRONT_DOMAIN: 'media.sussurro.app',
      CLOUDFRONT_KEY_PAIR_ID: 'K123',
      // No .env a chave fica numa linha só, com \n escapado.
      CLOUDFRONT_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
    });
    expect(env.CLOUDFRONT_PRIVATE_KEY).toBe(privateKey);
    expect(() =>
      loadApiEnv({
        ...base,
        MEDIA_URL_SIGNER: 'cloudfront',
        CLOUDFRONT_DOMAIN: 'media.sussurro.app',
        CLOUDFRONT_KEY_PAIR_ID: 'K123',
        CLOUDFRONT_PRIVATE_KEY: 'nao-e-pem',
      }),
    ).toThrow(/CLOUDFRONT_PRIVATE_KEY: inválida/);
  });

  it('em produção a mídia só sai pelo CloudFront', () => {
    expect(() => loadApiEnv({ ...base, NODE_ENV: 'production', EMAIL_SENDER: 'ses' })).toThrow(
      /MEDIA_URL_SIGNER: em produção use "cloudfront"/,
    );
  });
});
