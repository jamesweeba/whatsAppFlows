import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { FAILURE_WINDOW_MS, LoginThrottleService, MAX_FAILURES_PER_EMAIL, MAX_FAILURES_PER_IP } from './login-throttle.service.js';

describe('LoginThrottleService', () => {
  let throttle: LoginThrottleService;

  beforeEach(() => {
    vi.useFakeTimers();
    throttle = new LoginThrottleService();
  });
  afterEach(() => vi.useRealTimers());

  const fail = (times: number, email: string, ip = '1.1.1.1') => {
    for (let i = 0; i < times; i++) throttle.recordFailure(email, ip);
  };

  it('locks an email after too many failures, from any IP and in any letter case', () => {
    fail(MAX_FAILURES_PER_EMAIL - 1, 'ama@shop.com');
    expect(() => throttle.assertAllowed('ama@shop.com', '9.9.9.9')).not.toThrow();

    fail(1, 'Ama@Shop.com');
    expect(() => throttle.assertAllowed('ama@shop.com', '9.9.9.9')).toThrow(/Too many failed login attempts\. Try again in 15 minutes/);
    try {
      throttle.assertAllowed('AMA@shop.com', '8.8.8.8');
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });

  it('unlocks once the window has passed', () => {
    fail(MAX_FAILURES_PER_EMAIL, 'ama@shop.com');
    vi.advanceTimersByTime(FAILURE_WINDOW_MS - 60_000);
    expect(() => throttle.assertAllowed('ama@shop.com', undefined)).toThrow(/1 minute\./);
    vi.advanceTimersByTime(60_000);
    expect(() => throttle.assertAllowed('ama@shop.com', undefined)).not.toThrow();
  });

  it('locks an IP that tries many different emails', () => {
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) throttle.recordFailure(`user${i}@x.com`, '6.6.6.6');
    expect(() => throttle.assertAllowed('someone-new@x.com', '6.6.6.6')).toThrow(/Too many/);
    expect(() => throttle.assertAllowed('someone-new@x.com', '7.7.7.7')).not.toThrow();
  });

  it('clears an email after a successful login', () => {
    fail(MAX_FAILURES_PER_EMAIL - 1, 'ama@shop.com');
    throttle.recordSuccess('ama@shop.com');
    fail(MAX_FAILURES_PER_EMAIL - 1, 'ama@shop.com');
    expect(() => throttle.assertAllowed('ama@shop.com', undefined)).not.toThrow();
  });
});

describe('AuthService.login with attempt limits', () => {
  let prisma: any;
  let auth: AuthService;

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: vi.fn(async ({ where }: any) =>
          where.email === 'admin@marketix.app'
            ? { id: 'u1', email: 'admin@marketix.app', password: await hash('correct-horse', 4), firstName: 'A', lastName: 'B', role: 'SUPER_ADMIN', createdAt: new Date() }
            : null,
        ),
      },
    };
    auth = new AuthService(prisma, { signAsync: vi.fn().mockResolvedValue('token') } as any, new LoginThrottleService());
  });

  it('refuses even the right password once the account is locked', async () => {
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
      await expect(auth.login({ email: 'admin@marketix.app', password: 'guess' }, '1.2.3.4')).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(auth.login({ email: 'admin@marketix.app', password: 'correct-horse' }, '5.6.7.8')).rejects.toThrow(/Too many failed login attempts/);
  });

  it('counts guesses at unknown emails against the IP, with the same error as a wrong password', async () => {
    await expect(auth.login({ email: 'nobody@x.com', password: 'x' }, '1.2.3.4')).rejects.toThrow('Invalid email or password');
  });

  it('logs in normally with the right password', async () => {
    await expect(auth.login({ email: 'admin@marketix.app', password: 'correct-horse' }, '1.2.3.4')).resolves.toMatchObject({ accessToken: 'token' });
  });
});
