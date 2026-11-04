import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { RolesGuard } from './roles.guard.js';

const context = (user: any, roles?: UserRole[]) => {
  const handler = () => undefined;
  if (roles) Reflect.defineMetadata('roles', roles, handler);
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
};

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('lets a super admin through and stops a vendor', () => {
    expect(guard.canActivate(context({ role: UserRole.SUPER_ADMIN }, [UserRole.SUPER_ADMIN]))).toBe(true);
    expect(() => guard.canActivate(context({ role: UserRole.VENDOR }, [UserRole.SUPER_ADMIN]))).toThrow(ForbiddenException);
  });

  it('does nothing on routes without @Roles', () => {
    expect(guard.canActivate(context({ role: UserRole.VENDOR }))).toBe(true);
  });
});
