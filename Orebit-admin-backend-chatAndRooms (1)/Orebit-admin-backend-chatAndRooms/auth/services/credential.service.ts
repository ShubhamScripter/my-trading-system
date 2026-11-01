import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import argon2 from 'argon2';
import type { AdminCredential } from '@prisma/client';
import { config } from '../../src/config';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { LOCKOUT, PASSWORD } from '../auth.constants';
import { emailLocalPart } from '../auth.utility';
import { AdminDbOperation } from '../persistence/admin.dboperation';

/**
 * Password hashing, verification, policy, and lockout.
 *
 * Everything that touches a plaintext password is in this one file, so "where can
 * a password appear" has a single answer.
 */

/**
 * argon2id parameters.
 *
 * id rather than i or d: it takes argon2d's resistance to GPU cracking and
 * argon2i's resistance to side-channel attacks, and is what OWASP recommends for
 * password storage.
 *
 * 19 MiB × 2 iterations × 1 lane is the OWASP minimum. Deliberately at the floor
 * rather than above it: this runs synchronously inside a sign-in request, and
 * memory cost is per concurrent hash — pushing it higher turns the login endpoint
 * into its own denial-of-service vector, where an attacker spends one request to
 * make the server spend 64 MiB. The floor plus rate limiting plus durable lockout
 * is a better trade than a high work factor with the same limits.
 *
 * Note this is one of the few parameters NOT raised for the admin service even
 * though the population is small. The DoS arithmetic does not care how many
 * legitimate admins there are — it cares how cheaply an anonymous caller can make
 * the server allocate memory, and that is unchanged.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

function hasRequiredCharacterClasses(password: string): boolean {
  return (
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^a-zA-Z0-9\s]/.test(password)
  );
}

/**
 * A small embedded list of the passwords that actually get tried.
 *
 * Not a 100k-entry corpus and not a dependency: these are the handful that
 * survive an "all four character classes" rule while still being
 * among the first things any credential-stuffing list tries. It is the policy's
 * blind spot, not a general dictionary.
 *
 * The `orebit`/`admin` entries are here because this is an admin panel — the
 * organisation's own name plus a year is the single most predictable password an
 * internal tool ever receives.
 */
const COMMON_PASSWORDS = new Set([
  'password123!',
  'password1234!',
  'passw0rd123!',
  'qwerty12345!',
  'welcome123!!',
  'letmein1234!',
  'admin1234567',
  'administrator1!',
  'orebit123456',
  'orebit1234!',
  'orebitadmin1!',
  'orebit@admin1',
  'adminorebit1!',
  'p@ssw0rd1234',
  'superadmin1!',
]);

/**
 * The plaintext hashed to produce the timing mask.
 *
 * Its VALUE is irrelevant and it is deliberately not a plausible password: nothing
 * ever verifies successfully against the resulting hash, and it is never stored. What
 * matters is only that hashing it produces a well-formed argon2id encoded string with
 * this deployment's exact parameters, so that verifying against it costs the same
 * memory and the same iterations a real credential does.
 */
const TIMING_MASK_PLAINTEXT = 'orebit-admin-timing-mask-not-a-credential';

@Injectable()
export class CredentialService implements OnModuleInit {
  private readonly logger = new Logger('CredentialService');

  /**
   * A real argon2id hash, computed once, used only to burn time. See `verifyDummy`.
   */
  private timingMaskHash: string | null = null;

  constructor(private readonly admins: AdminDbOperation) {}

  /**
   * Precompute the timing mask at boot rather than on first use.
   *
   * Lazily computing it would put a full extra argon2 hash inside the FIRST request
   * that hits an unknown address — which is the one request the mask exists to make
   * indistinguishable, and would make it conspicuously slower than every other. Doing
   * it at startup costs ~50ms once, off the request path.
   *
   * Non-fatal: `verifyDummy` recomputes on demand if this did not run (in a unit test
   * that constructs the service directly, for one), so a failure here degrades the
   * timing mask rather than refusing to boot the service.
   */
  async onModuleInit(): Promise<void> {
    try {
      this.timingMaskHash = await this.hash(TIMING_MASK_PLAINTEXT);
    } catch (err) {
      this.logger.error({ err }, 'could not precompute the timing mask hash');
    }
  }

  /**
   * ═══ THE TIMING MASK ═══════════════════════════════════════════════════════
   *
   * Do the work a real password verification costs, and throw the answer away.
   *
   * The problem this closes: `withPassword` used to return `invalid_credentials` for
   * an unknown address without ever reaching argon2, and the code said so — "no
   * timing tell worth chasing". That was wrong on its own terms. argon2id at 19 MiB
   * and two iterations is ~50ms and is the DOMINANT cost of the request; skipping it
   * makes the unknown-email path an order of magnitude faster than the known-email
   * one. The two responses being byte-identical does not help when the clock
   * separates them, and an attacker measuring a few hundred requests can enumerate
   * which company addresses are admins — which is the first step of every attack the
   * rest of this file defends against.
   *
   * Uses the same options, the same pepper and `verify`'s own error handling, so the
   * work is not merely similar but identical. The result is discarded because a
   * password can never match this hash.
   */
  async verifyDummy(password: string): Promise<void> {
    // `??=` rather than a bare read: `onModuleInit` may not have run (a unit test
    // building the class by hand), and a null here would silently skip the mask —
    // reintroducing exactly the leak this method exists to close.
    this.timingMaskHash ??= await this.hash(TIMING_MASK_PLAINTEXT);
    await this.verify(this.timingMaskHash, password);
  }

  /**
   * Field-level rules (length, character classes) are already enforced by
   * `passwordSchema`. This is for the checks a field schema structurally cannot
   * do — the ones that compare the password against the account's own values.
   *
   * Those matter more than they look: `alice@orebit.io` / `Alice2024!aa` passes
   * every length and class rule and is among the first things an attacker tries
   * against that specific address.
   */
  assertPolicy(password: string, context: { email?: string; name?: string }): void {
    const lower = password.toLowerCase();

    if (COMMON_PASSWORDS.has(lower)) {
      throw new ProblemException({
        type: ERR.PASSWORD_WEAK,
        detail: 'This password is too common. Choose something less predictable.',
      });
    }

    if (context.email !== undefined) {
      const local = emailLocalPart(context.email).toLowerCase();
      // Guard the length: a two-character local-part would match almost anything.
      if (local.length >= 4 && lower.includes(local)) {
        throw new ProblemException({
          type: ERR.PASSWORD_WEAK,
          detail: 'Password must not contain your email address.',
        });
      }
    }

    if (context.name !== undefined) {
      // Each word of the name separately, not the whole string: "Priya Sharma"
      // as one token would almost never match, while `priya2024!Xy` is exactly
      // the password this rule exists to refuse.
      for (const word of context.name.toLowerCase().split(/\s+/)) {
        if (word.length >= 4 && lower.includes(word)) {
          throw new ProblemException({
            type: ERR.PASSWORD_WEAK,
            detail: 'Password must not contain your name.',
          });
        }
      }
    }

    // Belt-and-braces: the schema already enforces these, but this method is also
    // reachable from paths that build a password from something other than a
    // parsed DTO — db/seed.ts, for one — and a silent bypass there would be a
    // real hole.
    if (
      password.length < PASSWORD.MIN_LENGTH ||
      password.length > PASSWORD.MAX_LENGTH ||
      !hasRequiredCharacterClasses(password)
    ) {
      throw new ProblemException({ type: ERR.PASSWORD_WEAK });
    }
  }

  /**
   * Hash for storage.
   *
   * The pepper goes in as argon2's `secret` parameter rather than being
   * concatenated onto the password. Concatenation would silently truncate against
   * argon2's input handling and, more importantly, would bake the pepper into the
   * hash in a way that cannot be rotated. As a `secret` it is a separate input,
   * so the stored hash records only that a secret was used.
   */
  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      ...ARGON2_OPTIONS,
      secret: Buffer.from(config.PASSWORD_PEPPER, 'utf8'),
    });
  }

  /** Constant-time by construction — argon2's own verify. Never throws for a
   *  wrong password; returns false. */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password, {
        secret: Buffer.from(config.PASSWORD_PEPPER, 'utf8'),
      });
    } catch {
      // A malformed or truncated hash in the database. Treated as a mismatch
      // rather than an error, so a corrupted row cannot be probed by watching for
      // a 500.
      return false;
    }
  }

  /**
   * Compare a password against a credential, maintaining the lockout counters.
   *
   * This is the whole lockout policy in one place, and it is intentionally
   * database-backed rather than Redis-backed: it must keep working with the cache
   * down, which is exactly when brute force is most attractive.
   *
   * ─── What it returns, and what it throws ───────────────────────────────────
   *
   * Returns `{ valid: false }` for an ordinary wrong password — the caller turns that
   * into `invalid_credentials`, so this method never gets to decide how a failure is
   * disclosed. It THROWS only for the two states that are not "wrong password":
   * `account_locked` (a wait, with `Retry-After`) and `admin_login_manual_review` (no
   * wait; a human must act).
   *
   * On success it reports `priorFailures`, the streak that was standing before it was
   * cleared. The caller records an audit event when that is non-zero — a streak
   * ending in a success is an admin who fumbled and remembered, and after the clear
   * there is no other way to tell that from a clean sign-in.
   */
  async checkPassword(
    credential: AdminCredential,
    password: string,
  ): Promise<{ valid: boolean; priorFailures: number }> {
    if (credential.lockedUntil !== null && credential.lockedUntil.getTime() > Date.now()) {
      throw new ProblemException({
        type: ERR.ACCOUNT_LOCKED,
        retryAfterSeconds: Math.ceil((credential.lockedUntil.getTime() - Date.now()) / 1000),
      });
    }

    const valid = await this.verify(credential.passwordHash, password);

    if (valid) {
      // Captured before the clear, because after it the streak is unrecoverable.
      const priorFailures = credential.failedAttempts;

      // Only write when there is something to clear — the common case is a clean
      // sign-in, and an unconditional write would make every sign-in a write.
      // `lockoutStrikes` is deliberately not among what is cleared; see
      // `clearFailedAttempts`.
      if (credential.failedAttempts > 0 || credential.lockedUntil !== null) {
        await this.admins.clearFailedAttempts(credential.id);
      }
      return { valid: true, priorFailures };
    }

    const { outcome } = await this.admins.registerFailedAttempt(credential.id, {
      maxAttempts: LOCKOUT.MAX_FAILED_ATTEMPTS,
      lockDurationSeconds: LOCKOUT.DURATION_SECONDS,
      strikeMemorySeconds: LOCKOUT.STRIKE_MEMORY_SECONDS,
    });

    if (outcome === 'locked') {
      throw new ProblemException({
        type: ERR.ACCOUNT_LOCKED,
        retryAfterSeconds: LOCKOUT.DURATION_SECONDS,
      });
    }

    if (outcome === 'review-opened') {
      // NO `retryAfterSeconds`. There is nothing to wait for, and sending one would
      // have the client render a countdown that expires into another refusal.
      throw new ProblemException({
        type: ERR.ADMIN_LOGIN_MANUAL_REVIEW,
        detail:
          'This account has been locked repeatedly and is now suspended pending review ' +
          'by a super administrator. Waiting will not restore access.',
      });
    }

    return { valid: false, priorFailures: credential.failedAttempts };
  }
}
