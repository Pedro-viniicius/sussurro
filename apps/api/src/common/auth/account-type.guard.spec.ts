import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AccountTypeGuard } from './account-type.guard.js';
import type { AuthContext } from './auth-context.js';
import { REQUIRED_ACCOUNT_TYPE } from './decorators.js';

function context(required: string | undefined, auth: AuthContext | undefined): ExecutionContext {
  const handler = () => undefined;
  if (required !== undefined) {
    Reflect.defineMetadata(REQUIRED_ACCOUNT_TYPE, required, handler);
  }
  return {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => ({ auth }) }),
  } as unknown as ExecutionContext;
}

const guard = new AccountTypeGuard(new Reflector());
const person: AuthContext = {
  userId: 'u',
  accountType: 'personal',
  familyId: 'f',
  emailVerified: true,
};
const creator: AuthContext = { ...person, accountType: 'creator' };

describe('AccountTypeGuard (ADR 0008)', () => {
  it('rota sem @RequireAccountType passa', () => {
    expect(guard.canActivate(context(undefined, creator))).toBe(true);
  });

  it('[PERM-05] tipo certo passa; o outro tipo recebe 403 ACCOUNT_TYPE_NOT_ALLOWED', () => {
    expect(guard.canActivate(context('personal', person))).toBe(true);
    expect(() => guard.canActivate(context('personal', creator))).toThrow(
      expect.objectContaining({ code: 'ACCOUNT_TYPE_NOT_ALLOWED', httpStatus: 403 }),
    );
    expect(() => guard.canActivate(context('personal', undefined))).toThrow(
      expect.objectContaining({ code: 'ACCOUNT_TYPE_NOT_ALLOWED' }),
    );
  });
});
