import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { AccessTokenService } from './access-token.service.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { AppConfig } from '../../config/config.module.js';
import { FakeClock } from '../../testing/fake-clock.js';
import { TEST_JWT_SECRET, testEnv } from '../../testing/test-env.js';

const claims = {
  sub: '01a189e0-af57-7000-85fe-2054e618fea6',
  acct: 'personal' as const,
  fam: '01a189e0-af57-7000-85fe-2054e618fea7',
};

function service(overrides: Record<string, string> = {}, clock = new FakeClock()) {
  return { clock, tokens: new AccessTokenService(new AppConfig(testEnv(overrides)), clock) };
}

describe('AccessTokenService', () => {
  it('[AUTH-06] assina HS256 com kid e validade de 15 min, e verifica de volta', async () => {
    const { clock, tokens } = service();
    const signed = await tokens.sign(claims);
    expect(signed.expiresAt.getTime() - clock.now().getTime()).toBe(15 * 60_000);
    const header = JSON.parse(
      Buffer.from(signed.token.split('.')[0] ?? '', 'base64url').toString(),
    ) as Record<string, string>;
    expect(header).toEqual({ alg: 'HS256', kid: 'k1', typ: 'JWT' });
    await expect(tokens.verify(signed.token)).resolves.toEqual(claims);
  });

  it('[AUTH-11] expirado pelo relógio → 401', async () => {
    const { clock, tokens } = service();
    const signed = await tokens.sign(claims);
    clock.advance(15 * 60_000);
    await expect(tokens.verify(signed.token)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      httpStatus: 401,
    });
  });

  it('[AUTH-11] outro segredo, kid desconhecido e claims inválidos → 401', async () => {
    const { tokens } = service();
    const now = Math.floor(Date.parse('2026-10-29T12:00:00.000Z') / 1000);
    const build = (payload: Record<string, unknown>, kid: string, secret: string) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256', kid })
        .setIssuer('sussurro-api')
        .setAudience('sussurro-app')
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .setSubject(claims.sub)
        .sign(new TextEncoder().encode(secret));

    const tampered = [
      await build({ acct: 'personal', fam: claims.fam }, 'k1', 'x'.repeat(40)),
      await build({ acct: 'personal', fam: claims.fam }, 'k2', TEST_JWT_SECRET),
      await build({ acct: 'admin', fam: claims.fam }, 'k1', TEST_JWT_SECRET),
      'nao.e.jwt',
    ];
    for (const token of tampered) {
      await expect(tokens.verify(token)).rejects.toBeInstanceOf(DomainError);
    }
  });

  it('rotação de segredo: token assinado com o kid anterior ainda é aceito', async () => {
    const previousSecret = 'segredo-anterior-com-mais-de-32-caracteres'; // gitleaks:allow (fictício, só de teste)
    const old = service({ JWT_ACCESS_SECRET: previousSecret, JWT_ACCESS_KID: 'k0' });
    const signedWithOld = await old.tokens.sign(claims);

    const rotated = service({
      JWT_ACCESS_KID: 'k1',
      JWT_ACCESS_PREVIOUS_SECRET: previousSecret,
      JWT_ACCESS_PREVIOUS_KID: 'k0',
    });
    await expect(rotated.tokens.verify(signedWithOld.token)).resolves.toEqual(claims);

    const withoutPrevious = service();
    await expect(withoutPrevious.tokens.verify(signedWithOld.token)).rejects.toBeInstanceOf(
      DomainError,
    );
  });
});
