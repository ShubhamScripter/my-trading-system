import { Injectable } from "@nestjs/common";
import argon2 from "argon2";
import type { Credential } from "@prisma/client";
import { config } from "../../src/config";
import { ERR } from "../../src/contracts";
import { ProblemException } from "../../src/http";
import { PASSWORD } from "../auth.constants";
import { policy } from "../limits";
import { emailLocalPart } from "../auth.utility";
import { UserDbOperation } from "../persistence/user.dboperation";

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
 * rather than above it: this runs synchronously inside a login request, and memory
 * cost is per concurrent hash — pushing it higher turns the login endpoint into
 * its own denial-of-service vector, where an attacker spends one request to make
 * the server spend 64 MiB. The floor plus rate limiting plus durable lockout is a
 * better trade than a high work factor with the same limits.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A small embedded list of the passwords that actually get tried.
 *
 * Not a 100k-entry corpus, and not a dependency: a list that size belongs behind
 * the settings engine where it can be updated without a deploy. The intent is to
 * cover the policy's blind spot — the handful of passwords that satisfy the rules
 * and are still the first thing any credential-stuffing list tries.
 *
 * NOTE: the actual policy is 4 of 4 character classes, 8–20 characters (see
 * `PASSWORD` in auth.constants.ts), which is stricter than the 3-of-4 rule this
 * list was drawn up against. Most entries below cannot reach it — `passwordSchema`
 * rejects them for a missing uppercase or symbol long before this check runs. The
 * list needs rebuilding against the real policy to earn its place; until then it
 * is close to dead weight, and should not be read as meaningful coverage.
 */
function hasRequiredCharacterClasses(password: string): boolean {
  return (
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^a-zA-Z0-9\s]/.test(password)
  );
}

const COMMON_PASSWORDS = new Set([
  "password1!",
  "password123",
  "password123!",
  "passw0rd123",
  "qwerty123!",
  "qwerty12345",
  "welcome123!",
  "welcome1234",
  "admin123456",
  "letmein123!",
  "iloveyou123",
  "monkey12345",
  "football123",
  "sunshine123",
  "princess123",
  "dragon12345",
  "abc123456789",
  "trustno1234",
  "baseball123",
  "superman123",
  "p@ssw0rd123",
  "orebit12345",
  "orebit123!",
]);

@Injectable()
export class CredentialService {
  constructor(private readonly users: UserDbOperation) {}

  /**
   * Field-level rules (length, character classes) are already enforced by
   * `passwordSchema`. This is for the checks a field schema structurally cannot
   * do — the ones that compare the password against the account's other values.
   *
   * Those matter more than they look: `alice@example.com` / `alice12345` passes
   * every length and class rule and is among the first things an attacker tries
   * against that specific address.
   */
  assertPolicy(
    password: string,
    context: { email?: string; username?: string },
  ): void {
    const lower = password.toLowerCase();

    if (COMMON_PASSWORDS.has(lower)) {
      throw new ProblemException({
        type: ERR.PASSWORD_WEAK,
        detail:
          "This password is too common. Choose something less predictable.",
      });
    }

    if (context.email !== undefined) {
      const local = emailLocalPart(context.email).toLowerCase();
      // Guard the length: a two-character local-part would match almost anything.
      if (local.length >= 4 && lower.includes(local)) {
        throw new ProblemException({
          type: ERR.PASSWORD_WEAK,
          detail: "Password must not contain your email address.",
        });
      }
    }

    if (
      context.username !== undefined &&
      context.username.length >= 4 &&
      lower.includes(context.username.toLowerCase())
    ) {
      throw new ProblemException({
        type: ERR.PASSWORD_WEAK,
        detail: "Password must not contain your username.",
      });
    }

    // Belt-and-braces: the schema already enforces these, but this method is also
    // reachable from paths that build a password from something other than a
    // parsed DTO, and a silent bypass here would be a real hole.
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
      secret: Buffer.from(config.PASSWORD_PEPPER, "utf8"),
    });
  }

  /** Constant-time by construction — argon2's own verify. Never throws for a
   *  wrong password; returns false. */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password, {
        secret: Buffer.from(config.PASSWORD_PEPPER, "utf8"),
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
   */
  async checkPassword(
    credential: Credential,
    password: string,
  ): Promise<boolean> {
    if (
      credential.lockedUntil !== null &&
      credential.lockedUntil.getTime() > Date.now()
    ) {
      throw new ProblemException({
        type: ERR.ACCOUNT_LOCKED,
        retryAfterSeconds: Math.ceil(
          (credential.lockedUntil.getTime() - Date.now()) / 1000,
        ),
      });
    }

    const valid = await this.verify(credential.passwordHash, password);

    if (valid) {
      // Only write when there is something to clear — the common case is a clean
      // login, and an unconditional write would make every login a write.
      if (
        credential.failedAttempts > 0 ||
        credential.lockedUntil !== null ||
        credential.lockoutStrikes > 0
      ) {
        await this.users.clearFailedAttempts(credential.id);
      }
      return true;
    }

    const { LADDER_SECONDS, MAX_FAILED_ATTEMPTS, STRIKE_TTL_SECONDS } = policy().LOCKOUT;

    const { locked, lockedUntil } = await this.users.registerFailedAttempt(
      credential.id,
      MAX_FAILED_ATTEMPTS,
      (strike) => new Date(Date.now() + rungFor(LADDER_SECONDS, strike) * 1000),
      STRIKE_TTL_SECONDS,
    );

    if (locked) {
      throw new ProblemException({
        type: ERR.ACCOUNT_LOCKED,
        // The rung actually served, read back from the write rather than recomputed.
        // Recomputing would drift the moment the ladder or the strike count changed
        // under a concurrent attempt, and a wrong `Retry-After` on a lock is exactly
        // the thing that produces a retry storm.
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(((lockedUntil?.getTime() ?? Date.now()) - Date.now()) / 1000),
        ),
      });
    }
    return false;
  }
}

/**
 * The penalty for the nth lock. The last rung repeats forever.
 *
 * Escalating rather than flat, because the two populations this has to separate
 * behave differently over time. Somebody who forgets their own password waits fifteen
 * minutes once and never sees rung two; something grinding an account trips
 * repeatedly and is pushed to a day, which is the difference between a nuisance and a
 * cost. A flat window lets that second caller pace itself and continue indefinitely.
 */
function rungFor(ladder: readonly number[], strike: number): number {
  const index = Math.min(Math.max(strike, 1), ladder.length) - 1;
  return ladder[index] as number;
}
