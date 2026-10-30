import { generateKeyPairSync, verify } from 'node:crypto';

import { S3Client } from '@aws-sdk/client-s3';
import { beforeAll, describe, expect, it } from 'vitest';

import { cloudFrontObjectUrl, CloudFrontMediaUrlSigner } from './cloudfront-url-signer.js';
import { createS3Clients, presignPutUrl, S3PresignMediaUrlSigner } from './s3-object-storage.js';

const settings = {
  region: 'sa-east-1',
  bucket: 'sussurro-media',
  endpoint: 'http://localhost:8333',
  publicEndpoint: 'http://192.168.0.10:8333',
  forcePathStyle: true,
};
const signingDate = new Date('2026-10-29T12:00:00.000Z');

beforeAll(() => {
  // Credenciais fictícias: a assinatura é calculada localmente, sem rede.
  process.env.AWS_ACCESS_KEY_ID = 'local';
  process.env.AWS_SECRET_ACCESS_KEY = 'local';
});

describe('URL PUT pré-assinada (ADR 0009, offline)', () => {
  it('[MID-03] assina Content-Type e Content-Length, sem o checksum CRC32 de corpo vazio', async () => {
    const { public: publicClient } = createS3Clients(settings);
    const url = new URL(
      await presignPutUrl(publicClient, settings.bucket, {
        key: 'incoming/u/m',
        contentType: 'image/jpeg',
        contentLength: 12_345,
        expiresInS: 600,
        signingDate,
      }),
    );
    expect(url.host).toBe('192.168.0.10:8333');
    expect(url.pathname).toBe('/sussurro-media/incoming/u/m');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261029T120000Z');
    expect([...url.searchParams.keys()].filter((key) => /checksum/i.test(key))).toEqual([]);
  });

  it('o cliente interno (HEAD/Delete) usa o endpoint interno; o público só assina', () => {
    const { internal, public: publicClient } = createS3Clients(settings);
    expect(internal).not.toBe(publicClient);
    const same = createS3Clients({ ...settings, publicEndpoint: undefined });
    expect(same.internal).toBe(same.public);
    const aws = createS3Clients({ ...settings, endpoint: undefined, publicEndpoint: undefined });
    expect(aws.internal).toBeInstanceOf(S3Client);
  });

  it('leitura em dev: GET pré-assinado no endpoint público, com a validade pedida', async () => {
    const { public: publicClient } = createS3Clients(settings);
    const signer = new S3PresignMediaUrlSigner(publicClient, settings.bucket);
    const url = new URL(
      await signer.sign(
        'media/m/full.jpg',
        new Date(signingDate.getTime() + 21_600_000),
        signingDate,
      ),
    );
    expect(url.host).toBe('192.168.0.10:8333');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('21600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});

describe('URL assinada do CloudFront (PERM-16)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const signer = new CloudFrontMediaUrlSigner({
    domain: 'media.sussurro.app',
    keyPairId: 'K123',
    privateKey,
  });

  it('[PERM-16] URL https do domínio, com Expires, Signature e Key-Pair-Id verificáveis', async () => {
    const expiresAt = new Date('2026-10-29T18:00:00.000Z');
    const url = new URL(await signer.sign('media/abc/full.jpg', expiresAt));
    expect(`${url.origin}${url.pathname}`).toBe('https://media.sussurro.app/media/abc/full.jpg');
    expect(url.searchParams.get('Expires')).toBe(String(expiresAt.getTime() / 1000));
    expect(url.searchParams.get('Key-Pair-Id')).toBe('K123');
    const policy = JSON.stringify({
      Statement: [
        {
          Resource: 'https://media.sussurro.app/media/abc/full.jpg',
          Condition: { DateLessThan: { 'AWS:EpochTime': expiresAt.getTime() / 1000 } },
        },
      ],
    });
    const signature = Buffer.from(
      (url.searchParams.get('Signature') ?? '')
        .replace(/-/g, '+')
        .replace(/_/g, '=')
        .replace(/~/g, '/'),
      'base64',
    );
    expect(verify('RSA-SHA1', Buffer.from(policy), publicKey, signature)).toBe(true);
    const otherObject = policy.replace('abc', 'xyz');
    expect(verify('RSA-SHA1', Buffer.from(otherObject), publicKey, signature)).toBe(false);
  });

  it('codifica cada segmento da chave e aceita domínio com https', () => {
    expect(cloudFrontObjectUrl('https://cdn.exemplo.com/', 'media/a b/ç.jpg')).toBe(
      'https://cdn.exemplo.com/media/a%20b/%C3%A7.jpg',
    );
  });
});
