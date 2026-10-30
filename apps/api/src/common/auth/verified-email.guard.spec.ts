import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import type { AuthContext } from './auth-context.js';
import { REQUIRES_VERIFIED_EMAIL } from './decorators.js';
import { VerifiedEmailGuard } from './verified-email.guard.js';

function context(required: boolean, auth: AuthContext | undefined): ExecutionContext {
  const handler = () => undefined;
  if (required) {
    Reflect.defineMetadata(REQUIRES_VERIFIED_EMAIL, true, handler);
  }
  return {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => ({ auth }) }),
  } as unknown as ExecutionContext;
}

const guard = new VerifiedEmailGuard(new Reflector());
const verified: AuthContext = {
  userId: 'u',
  accountType: 'personal',
  familyId: 'f',
  emailVerified: true,
};
const unverified: AuthContext = { ...verified, emailVerified: false };

describe('VerifiedEmailGuard (X.3)', () => {
  it('rota sem @RequireVerifiedEmail passa mesmo sem e-mail confirmado', () => {
    expect(guard.canActivate(context(false, unverified))).toBe(true);
  });

  it('e-mail confirmado passa; não confirmado recebe 403 EMAIL_NOT_VERIFIED', () => {
    expect(guard.canActivate(context(true, verified))).toBe(true);
    expect(() => guard.canActivate(context(true, unverified))).toThrow(
      expect.objectContaining({ code: 'EMAIL_NOT_VERIFIED', httpStatus: 403 }),
    );
    expect(() => guard.canActivate(context(true, undefined))).toThrow(
      expect.objectContaining({ code: 'EMAIL_NOT_VERIFIED' }),
    );
  });
});
