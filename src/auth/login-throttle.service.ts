import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/** Failed logins allowed per email address within the window. */
export const MAX_FAILURES_PER_EMAIL = 5;
/** Failed logins allowed from one IP address within the window (it may try many emails). */
export const MAX_FAILURES_PER_IP = 20;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** Upper bound on tracked keys, so a flood of random emails can't exhaust memory. */
const MAX_TRACKED_KEYS = 50_000;

interface Failures {
  count: number;
  /** When the first failure in this window happened; the window resets after FAILURE_WINDOW_MS. */
  since: number;
}

/**
 * Slows password guessing: after too many failed logins for one email, or from one IP,
 * further attempts are refused (429) until the window passes, even with the right
 * password. Counts live in memory, so they reset on restart and are per server process.
 */
@Injectable()
export class LoginThrottleService {
  private readonly failures = new Map<string, Failures>();

  /** Throws 429 if this email or IP is locked out. Call before checking the password. */
  assertAllowed(email: string, ip: string | undefined) {
    const waitMs = Math.max(
      this.lockedFor(emailKey(email), MAX_FAILURES_PER_EMAIL),
      ip ? this.lockedFor(ipKey(ip), MAX_FAILURES_PER_IP) : 0,
    );
    if (waitMs > 0) {
      const minutes = Math.ceil(waitMs / 60_000);
      throw new HttpException(
        `Too many failed login attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(email: string, ip: string | undefined) {
    this.bump(emailKey(email));
    if (ip) this.bump(ipKey(ip));
  }

  /** A correct password clears that email's failures (not the IP's). */
  recordSuccess(email: string) {
    this.failures.delete(emailKey(email));
  }

  private lockedFor(key: string, max: number): number {
    const entry = this.current(key);
    if (!entry || entry.count < max) return 0;
    return entry.since + FAILURE_WINDOW_MS - Date.now();
  }

  private bump(key: string) {
    const entry = this.current(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    if (this.failures.size >= MAX_TRACKED_KEYS) this.prune();
    this.failures.set(key, { count: 1, since: Date.now() });
  }

  /** The entry if its window is still open; expired ones are dropped. */
  private current(key: string): Failures | null {
    const entry = this.failures.get(key);
    if (!entry) return null;
    if (Date.now() - entry.since >= FAILURE_WINDOW_MS) {
      this.failures.delete(key);
      return null;
    }
    return entry;
  }

  private prune() {
    for (const key of this.failures.keys()) this.current(key); // deleting while iterating a Map is safe
    // Still full of live entries: drop the oldest (Maps keep insertion order).
    for (const key of this.failures.keys()) {
      if (this.failures.size < MAX_TRACKED_KEYS) break;
      this.failures.delete(key);
    }
  }
}

const emailKey = (email: string) => `email:${email.trim().toLowerCase()}`;
const ipKey = (ip: string) => `ip:${ip}`;
