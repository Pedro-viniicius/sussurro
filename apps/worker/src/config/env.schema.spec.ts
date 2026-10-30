import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadWorkerEnv } from './env.schema.js';

const base = {
  DATABASE_URL: 'postgres://sussurro:sussurro@localhost:5432/sussurro',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadWorkerEnv', () => {
  it('aplica os padrões', () => {
    expect(loadWorkerEnv(base)).toMatchObject({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
  });

  it('CA2 (0.5): variável obrigatória ausente encerra citando a variável', () => {
    expect(() => loadWorkerEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(EnvValidationError);
    expect(() => loadWorkerEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(
      /REDIS_URL: obrigatória/,
    );
  });

  it('rejeita URL com protocolo errado', () => {
    expect(() => loadWorkerEnv({ ...base, DATABASE_URL: 'mysql://x@h/db' })).toThrow(
      /DATABASE_URL: inválida/,
    );
  });

  it('CONTA-05: hard delete em até 30 dias, a cada hora, configurável', () => {
    expect(loadWorkerEnv(base)).toMatchObject({
      ACCOUNT_PURGE_AFTER_DAYS: 30,
      MAINTENANCE_INTERVAL_MS: 3_600_000,
    });
    expect(loadWorkerEnv({ ...base, ACCOUNT_PURGE_AFTER_DAYS: '7' }).ACCOUNT_PURGE_AFTER_DAYS).toBe(
      7,
    );
    // A política de privacidade promete apagar em até 30 dias.
    expect(() => loadWorkerEnv({ ...base, ACCOUNT_PURGE_AFTER_DAYS: '31' })).toThrow(
      /ACCOUNT_PURGE_AFTER_DAYS/,
    );
  });

  it('Fase 2: mídia com padrões (fila media-jobs, 3 tentativas, 40 MP, rascunhos de 24 h)', () => {
    expect(loadWorkerEnv(base)).toMatchObject({
      S3_BUCKET_MEDIA: 'sussurro-media',
      SQS_QUEUE_MEDIA_JOBS: 'media-jobs',
      S3_FORCE_PATH_STYLE: false,
      MEDIA_JOBS_CONCURRENCY: 2,
      MEDIA_JOBS_WAIT_S: 20,
      MEDIA_JOBS_MAX_ATTEMPTS: 3,
      MEDIA_MAX_INPUT_PIXELS: 40_000_000,
      DRAFT_TTL_HOURS: 24,
      MEDIA_PROCESSING_TIMEOUT_MIN: 60,
    });
    expect(loadWorkerEnv({ ...base, S3_FORCE_PATH_STYLE: 'true' }).S3_FORCE_PATH_STYLE).toBe(true);
    expect(() => loadWorkerEnv({ ...base, MEDIA_JOBS_WAIT_S: '21' })).toThrow(/MEDIA_JOBS_WAIT_S/);
    expect(() => loadWorkerEnv({ ...base, AWS_ENDPOINT_URL_S3: 'ftp://x' })).toThrow(
      /AWS_ENDPOINT_URL_S3: inválida/,
    );
  });
});

describe('VIDEO_PROCESSOR (Fase 5, história 5.1, ADR 0006)', () => {
  const role = 'arn:aws:iam::123456789012:role/sussurro-mediaconvert';

  it('padrão passthrough (dev), com a fila video-events', () => {
    expect(loadWorkerEnv(base)).toMatchObject({
      VIDEO_PROCESSOR: 'passthrough',
      SQS_QUEUE_VIDEO_EVENTS: 'video-events',
    });
    expect(loadWorkerEnv({ ...base, VIDEO_PROCESSOR: '' }).VIDEO_PROCESSOR).toBe('passthrough');
  });

  it.each([['mux'], ['ffmpeg'], ['MediaConvert'], ['passthrough ']])(
    '[5.1 CA2] valor inválido (%s) impede o worker de subir',
    (value) => {
      expect(() => loadWorkerEnv({ ...base, VIDEO_PROCESSOR: value })).toThrow(EnvValidationError);
      expect(() => loadWorkerEnv({ ...base, VIDEO_PROCESSOR: value })).toThrow(
        /VIDEO_PROCESSOR: inválida \(esperado passthrough ou mediaconvert\)/,
      );
    },
  );

  it('mediaconvert exige a role do MediaConvert (ARN de role do IAM)', () => {
    expect(() => loadWorkerEnv({ ...base, VIDEO_PROCESSOR: 'mediaconvert' })).toThrow(
      /MEDIACONVERT_ROLE_ARN: obrigatória com VIDEO_PROCESSOR=mediaconvert/,
    );
    expect(() =>
      loadWorkerEnv({ ...base, VIDEO_PROCESSOR: 'mediaconvert', MEDIACONVERT_ROLE_ARN: 'role' }),
    ).toThrow(/MEDIACONVERT_ROLE_ARN: inválida/);
    expect(
      loadWorkerEnv({ ...base, VIDEO_PROCESSOR: 'mediaconvert', MEDIACONVERT_ROLE_ARN: role }),
    ).toMatchObject({ VIDEO_PROCESSOR: 'mediaconvert', MEDIACONVERT_ROLE_ARN: role });
    expect(() =>
      loadWorkerEnv({
        ...base,
        VIDEO_PROCESSOR: 'mediaconvert',
        MEDIACONVERT_ROLE_ARN: role,
        MEDIACONVERT_QUEUE_ARN: 'fila',
      }),
    ).toThrow(/MEDIACONVERT_QUEUE_ARN: inválida/);
  });

  it('[A-21] passthrough é recusado em produção (copiaria a localização do vídeo)', () => {
    expect(() => loadWorkerEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /VIDEO_PROCESSOR: em produção, só mediaconvert/,
    );
    expect(
      loadWorkerEnv({
        ...base,
        NODE_ENV: 'production',
        VIDEO_PROCESSOR: 'mediaconvert',
        MEDIACONVERT_ROLE_ARN: role,
        PUSH_SENDER: 'expo',
      }).VIDEO_PROCESSOR,
    ).toBe('mediaconvert');
  });
});

describe('push e observabilidade (Fase 6)', () => {
  it('padrões: push no log, fila push, 3 tentativas, recibos a cada 15 min, OTel desligado', () => {
    const env = loadWorkerEnv(base);
    expect(env).toMatchObject({
      PUSH_SENDER: 'log',
      SQS_QUEUE_PUSH: 'push',
      PUSH_JOBS_CONCURRENCY: 10,
      PUSH_JOBS_MAX_ATTEMPTS: 3,
      PUSH_RECEIPTS_INTERVAL_MS: 900_000,
      OTEL_ENABLED: false,
      SENTRY_ENVIRONMENT: 'local',
      SENTRY_TRACES_SAMPLE_RATE: 0,
    });
    expect(env.EXPO_ACCESS_TOKEN).toBeUndefined();
  });

  it('em produção o push só sai pelo Expo; valor desconhecido impede o worker de subir', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      VIDEO_PROCESSOR: 'mediaconvert',
      MEDIACONVERT_ROLE_ARN: 'arn:aws:iam::123456789012:role/sussurro-mediaconvert',
    };
    expect(() => loadWorkerEnv(production)).toThrow(/PUSH_SENDER: em produção, só expo/);
    expect(() => loadWorkerEnv({ ...base, PUSH_SENDER: 'fcm' })).toThrow(/PUSH_SENDER: inválida/);
    expect(() => loadWorkerEnv({ ...base, OTEL_ENABLED: 'talvez' })).toThrow(/OTEL_ENABLED/);
    expect(loadWorkerEnv({ ...base, OTEL_ENABLED: 'true' }).OTEL_ENABLED).toBe(true);
  });
});
