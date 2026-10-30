import { Injectable } from '@nestjs/common';
import { AccountTypeSchema, ErrorCode } from '@sussurro/shared';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { Clock } from '../../common/clock/clock.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { AppConfig } from '../../config/config.module.js';

export const ACCESS_TOKEN_ISSUER = 'sussurro-api';
export const ACCESS_TOKEN_AUDIENCE = 'sussurro-app';

/** Claims do access token (ADR 0007): `sub`, `acct` (tipo de conta) e `fam` (família). */
const AccessClaimsSchema = z.object({
  sub: z.uuid(),
  acct: AccountTypeSchema,
  fam: z.uuid(),
});

export type AccessClaims = z.infer<typeof AccessClaimsSchema>;

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

const encoder = new TextEncoder();

/**
 * JWT de acesso HS256 com `kid` (rotação de segredo). Só aceita HS256 (nada de `alg: none`), o
 * emissor e a audiência do Sussurro e um `kid` conhecido; o tempo vem do `Clock`.
 */
@Injectable()
export class AccessTokenService {
  private readonly keys = new Map<string, Uint8Array>();
  private readonly currentKid: string;
  private readonly ttlS: number;

  constructor(
    config: AppConfig,
    private readonly clock: Clock,
  ) {
    const { env } = config;
    this.currentKid = env.JWT_ACCESS_KID;
    this.ttlS = env.ACCESS_TOKEN_TTL_S;
    this.keys.set(env.JWT_ACCESS_KID, encoder.encode(env.JWT_ACCESS_SECRET));
    if (env.JWT_ACCESS_PREVIOUS_KID !== undefined && env.JWT_ACCESS_PREVIOUS_SECRET !== undefined) {
      this.keys.set(env.JWT_ACCESS_PREVIOUS_KID, encoder.encode(env.JWT_ACCESS_PREVIOUS_SECRET));
    }
  }

  async sign(claims: AccessClaims): Promise<SignedAccessToken> {
    const issuedAtS = Math.floor(this.clock.now().getTime() / 1000);
    const expiresAtS = issuedAtS + this.ttlS;
    const key = this.keys.get(this.currentKid);
    if (key === undefined) {
      throw new Error('Segredo atual do JWT ausente');
    }
    const token = await new SignJWT({ acct: claims.acct, fam: claims.fam })
      .setProtectedHeader({ alg: 'HS256', kid: this.currentKid, typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(ACCESS_TOKEN_ISSUER)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setIssuedAt(issuedAtS)
      .setExpirationTime(expiresAtS)
      .sign(key);
    return { token, expiresAt: new Date(expiresAtS * 1000) };
  }

  /** Valida assinatura, `kid`, algoritmo, emissor, audiência e validade. Falha = 401. */
  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid === undefined ? undefined : this.keys.get(header.kid);
          if (key === undefined) {
            throw new Error('kid desconhecido');
          }
          return key;
        },
        {
          algorithms: ['HS256'],
          issuer: ACCESS_TOKEN_ISSUER,
          audience: ACCESS_TOKEN_AUDIENCE,
          currentDate: this.clock.now(),
          requiredClaims: ['sub', 'iat', 'exp'],
        },
      );
      return AccessClaimsSchema.parse(payload);
    } catch {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 401, 'Token de acesso inválido');
    }
  }
}
