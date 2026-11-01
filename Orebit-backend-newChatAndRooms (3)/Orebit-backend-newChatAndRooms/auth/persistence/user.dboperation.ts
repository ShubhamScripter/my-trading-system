import { Injectable } from '@nestjs/common';
import type { Credential, OauthLink, OauthProvider, User } from '@prisma/client';
import { isUniqueViolation, PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';
import type { SealedValue } from '../../src/utils/sealed-secret';
import { assertNoRecentEmailChangeLocked } from './security-cooldown.lock';
import { stampRestrictionsLocked } from './restriction.lock';
import type { RestrictionPlan, SecurityContext } from '../../src/restrictions/restrictions.types';
import { lockUsernameClaim } from './username-claim.lock';
import { UsernameTakenError } from './username-reservation.dboperation';

/**
 * User-account persistence, including the credential and provider-link records
 * created atomically with a new user during registration.
 *
 * The only layer that touches Prisma. Every method takes and returns plain data
 * — no Prisma query fragments leak out, which is what lets the services above be
 * tested against a hand-written double instead of a database.
 */

/**
 * The anti-phishing envelope as it comes off the row.
 *
 * Structurally a `SealedValue`, and named separately because it is the READ shape: it
 * is what `findAntiPhishing` returns once it has established that all four columns are
 * present, so nothing downstream has to narrow four nullable fields it cannot use
 * individually. The mapping between column names and envelope fields is stated once,
 * here, exactly as `openFactorSecret` does it for TOTP.
 */
export interface AntiPhishingColumns {
  readonly ciphertext: Uint8Array<ArrayBuffer>;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly tag: Uint8Array<ArrayBuffer>;
  readonly keyVersion: number;
}

/**
 * What a purged column holds once the person behind it is gone.
 *
 * `.invalid` is reserved by RFC 2606 and guaranteed never to resolve, so a scrubbed
 * value that escapes into a mail path bounces rather than reaching a stranger who
 * happens to own a plausible-looking domain.
 *
 * One shared constant is safe because the only two columns that take it are non-unique
 * by design: `Registration.email` carries no unique index, and `MailDelivery.recipient`
 * is deliberately non-unique. The `users` columns needed per-account values when a
 * purge left a tombstone behind; it no longer does — the row is deleted — so there is
 * nothing on `users` left to scrub.
 */
const PURGED_EMAIL = 'purged@account.invalid';

/**
 * `Registration.ipAddress` is `NOT NULL` and typed `inet`, so it cannot be blanked and
 * cannot take a placeholder string. The unspecified address is the closest thing to
 * "no address" the type allows.
 */
const PURGED_IP = '0.0.0.0';

export interface CreateAccountInput {
  readonly email: string;
  readonly emailLower: string;
  readonly emailVerified: boolean;
  readonly username: string;
  readonly publicCode: string;
  readonly publicCodeKey: string;
  readonly referralCode: string;
  readonly referredByCode: string | null;
  readonly referredByUserId: string | null;
  readonly country: string;
  readonly countryIp: string | null;
  readonly avatarUrl: string | null;
  /** Pre-hashed. This layer never sees a plaintext password — hashing belongs to
   *  credential.service.ts, and keeping it out of here means a query log can
   *  never contain one. */
  readonly passwordHash: string | null;
  readonly oauth: {
    readonly provider: OauthProvider;
    readonly subject: string;
    readonly emailAtLink: string | null;
    readonly emailVerifiedByProvider: boolean;
    readonly avatarUrl?: string | null;
  } | null;
  /** Completed in the same transaction as the account it created. */
  readonly registrationId: string;
}

export interface UserWithCredential {
  readonly user: User;
  readonly credential: Credential | null;
}

@Injectable()
export class UserDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create the account, its credential, its provider link, and advance the
   * registration — all in one transaction.
   *
   * It has to be one transaction. A User without its Credential is an account
   * whose owner believes they set a password and cannot log in; a User without
   * its OauthLink is an account its owner can never reach through the provider
   * they signed up with. Neither is recoverable from the client's side, because
   * the registration row has already been consumed by then.
   *
   * Throws on unique violation — that is not a failure mode to handle here but
   * the signal the caller's allocation loop is built around. See
   * `services/user.service.ts`.
   *
   * ─── Why a signup takes the username claim lock ────────────────────────────
   *
   * Because `ix_users_username_active` is not the whole of username availability any
   * more. Since usernames became changeable, a name can also be RESERVED — held by an
   * account that released it and may want it back — and that reservation lives in a
   * different table, which no index on `users` can see.
   *
   * So a signup that only inserted and caught would happily allocate a username
   * somebody changed away from an hour ago: the unique index is satisfied, because no
   * live account holds it. The lock plus the check below is what stops that, and the
   * lock has to come FIRST — before the reservation read, not merely before the insert —
   * or a reservation committing in between lands on the wrong side of the check.
   *
   * `UsernameTakenError` is thrown rather than returned, so it joins the unique
   * violation on the path the allocation loop already understands: this candidate is
   * spoken for, try the next one.
   *
   * One transaction per candidate, which is what the caller already does — so each
   * attempt holds exactly one advisory lock, and releases it on commit or rollback
   * before the next candidate is tried. Locks never accumulate across the loop.
   */
  async createAccount(input: CreateAccountInput): Promise<UserWithCredential> {
    const userId = uuidv7();
    const usernameLower = input.username.toLowerCase();

    return this.prisma.$transaction(async (tx) => {
      await lockUsernameClaim(tx, usernameLower);

      const reserved = await tx.usernameReservation.count({
        where: { usernameLower, expiresAt: { gt: new Date() } },
      });
      if (reserved > 0) throw new UsernameTakenError();

      const user = await tx.user.create({
        data: {
          id: userId,
          email: input.email,
          emailLower: input.emailLower,
          emailVerifiedAt: input.emailVerified ? new Date() : null,
          username: input.username,
          usernameLower: input.username.toLowerCase(),
          publicCode: input.publicCode,
          publicCodeKey: input.publicCodeKey,
          referralCode: input.referralCode,
          referredByCode: input.referredByCode,
          referredByUserId: input.referredByUserId,
          countryDeclared: input.country,
          countryIp: input.countryIp,
          avatarUrl: input.avatarUrl,
        },
      });

      const credential =
        input.passwordHash === null
          ? null
          : await tx.credential.create({
              data: { id: uuidv7(), userId, kind: 'PASSWORD', passwordHash: input.passwordHash },
            });

      if (input.oauth !== null) {
        await tx.oauthLink.create({
          data: {
            id: uuidv7(),
            userId,
            provider: input.oauth.provider,
            subject: input.oauth.subject,
            emailAtLink: input.oauth.emailAtLink,
            emailVerifiedByProvider: input.oauth.emailVerifiedByProvider,
            avatarUrlAtLink: input.oauth.avatarUrl ?? null,
            lastLoginAt: new Date(),
          },
        });
      }

      // The last write of a successful signup, and the one that retires the
      // handle.
      //
      // `continuationSecretHash: null` is the load-bearing addition. It was
      // missing, so a completed registration kept a matchable hash in the column
      // indefinitely — unreachable in practice only because every finder happens
      // to filter on `completedAt: null`, which is a property of the queries
      // rather than of the data. One finder written without that clause, now or
      // later, and a spent `signupId` resolves again.
      //
      // Nulled in the SAME statement that sets `completedAt`, and inside the same
      // transaction that creates the account, so there is no interval in which a
      // finished signup still has a live handle. `pendingPasswordHash` was already
      // being cleared here for the same reason: a spent secret is not a credential
      // any more, and leaving it behind is only ever a thing to leak.
      await tx.registration.update({
        where: { id: input.registrationId },
        data: {
          userId,
          country: input.country,
          state: 'COMPLETED',
          completedAt: new Date(),
          passwordSet: input.passwordHash !== null,
          pendingPasswordHash: null,
          continuationSecretHash: null,
        },
      });

      return { user, credential };
    });
  }

  // ─── lookups ──────────────────────────────────────────────────────────────
  //
  // Every one filters `deletedAt: null`. A soft-deleted account must be invisible
  // to authentication, and the partial unique indexes are scoped the same way, so
  // omitting the filter here could return a row that a re-registration is
  // simultaneously allowed to duplicate.

  async findByEmail(emailLower: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { emailLower, deletedAt: null } });
  }

  async findByUsername(usernameLower: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { usernameLower, deletedAt: null } });
  }

  async findByPublicCode(publicCodeKey: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { publicCodeKey, deletedAt: null } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  async findByReferralCode(referralCode: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { referralCode, deletedAt: null } });
  }

  async emailExists(emailLower: string): Promise<boolean> {
    return (await this.prisma.user.count({ where: { emailLower, deletedAt: null } })) > 0;
  }

  /**
   * When this account's address last moved — the security cooldown's only input.
   *
   * `select`ed rather than returning the `User` that `findById` already fetches,
   * because this runs on the entry path of every protected security mutation and has
   * no use for the other twenty columns. Null covers both "never changed" and "no such
   * account"; `RecentSecurityChangePolicy` documents why the second is not this
   * layer's refusal to make.
   *
   * This is the ordinary, unlocked read. The race-safe one is
   * `assertNoRecentEmailChangeLocked`, which runs inside the mutation's transaction.
   */
  async findEmailChangedAt(userId: string): Promise<Date | null> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { emailChangedAt: true },
    });
    return row?.emailChangedAt ?? null;
  }

  /** The pair every login path needs: the account and its password credential, if
   *  it has one. One query rather than two, because "does this account have a
   *  password" and "what is its hash" are always asked together. */
  async findWithCredential(userId: string): Promise<UserWithCredential | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { credentials: { where: { kind: 'PASSWORD', deletedAt: null } } },
    });
    if (user === null) return null;
    const { credentials, ...rest } = user;
    return { user: rest as User, credential: credentials[0] ?? null };
  }

  async setCountry(userId: string, country: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { countryDeclared: country },
    });
  }

  async touchLastSeen(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
  }

  // ─── credentials ──────────────────────────────────────────────────────────

  /**
   * Create or replace the password credential.
   *
   * An upsert rather than an insert because this one method serves three cases:
   * a reset for an account that has a password, and a first-time *set* for the
   * two kinds of account that do not — one that skipped the step, and one created
   * through a provider. Resetting the lockout counters is part of it: a successful
   * reset should not leave the account locked from the failed attempts that
   * prompted it.
   *
   * ─── Why a transaction for one upsert ──────────────────────────────────────
   *
   * The security cooldown. `PasswordService` has already asked
   * `RecentSecurityChangePolicy` whether the account's email moved recently, but that
   * check ran before the argon2 hash — hundreds of milliseconds of real time in which
   * an email change can commit. The row lock inside
   * `assertNoRecentEmailChangeLocked` serialises this write against
   * `RetainedEmailDbOperation.changeEmail`, so the last word on the freeze is taken
   * here rather than in a check the write has outlived. A refusal throws, which rolls
   * this back with nothing written.
   */
  async upsertPassword(
    userId: string,
    passwordHash: string,
    restriction?: { context: SecurityContext; plan: RestrictionPlan },
  ): Promise<Credential> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, userId);

      const credential = await tx.credential.upsert({
        where: { userId_kind: { userId, kind: 'PASSWORD' } },
        create: { id: uuidv7(), userId, kind: 'PASSWORD', passwordHash },
        update: { passwordHash, failedAttempts: 0, lockedUntil: null, deletedAt: null },
      });

      // Same commit as the password — see `stampRestrictionsLocked`. This is the
      // SECOND password-change path (`POST /auth/password`); the settings one is
      // `replacePassword` / `createPasswordIfAbsent` above. Both are the one trigger
      // action, and wiring only one of them would leave the other as an unguarded door.
      if (restriction) await stampRestrictionsLocked(tx, restriction.context, restriction.plan);
      return credential;
    });
  }

  /**
   * ═══ THE TWO WRITES THAT KNOW WHICH DIRECTION THEY ARE GOING ════════════════
   *
   * `upsertPassword` above is direction-blind: it creates when there is no row and
   * replaces when there is, and it cannot tell a caller which of the two happened.
   * That is right for the flows it was written for and wrong for `src/settings/password/`,
   * where the direction IS the authorisation:
   *
   *   `set`    is authorised by the account having NO password. An upsert would
   *            overwrite one, which is the exact write that must not happen.
   *   `reset`  and `forgot` are authorised against an EXISTING password. An upsert
   *            would create one for an account that had none, laundering a flow whose
   *            preconditions were never checked.
   *
   * A service-level `findWithCredential` before the write cannot close either gap: the
   * argon2 hash between the read and the write is hundreds of milliseconds of real
   * time, which is ample for a concurrent request to change the answer. So the
   * precondition is re-stated as a PREDICATE on the write itself and the database is
   * the arbiter, exactly as `assertNoRecentEmailChangeLocked` is the last word on the
   * freeze rather than the check that preceded the hash.
   *
   * Both run inside the same cooldown-locked transaction `upsertPassword` uses, for the
   * same reason it does.
   */

  /**
   * Create the password credential, and refuse if one already exists.
   *
   * `false` means "this account already has a password" — the loser of a race between
   * two concurrent `set` requests, or a caller whose precondition went stale. The
   * UNIQUE INDEX on `(userId, kind)` is what decides, not a read, so both requests
   * cannot win: one inserts and the other raises 23505.
   *
   * ─── The soft-deleted row, and why it is a separate statement ───────────────
   *
   * `deletedAt` is part of the model but nothing in this codebase soft-deletes a
   * credential today, so this branch is unreachable at present. It is written anyway
   * because the unique index does NOT exclude soft-deleted rows: if one ever existed,
   * `findWithCredential` would report "no password" (it filters `deletedAt: null`)
   * while `create` raised a violation — an account that could neither set nor reset.
   * Reviving the row is the same write `upsertPassword`'s update arm already performs.
   */
  async createPasswordIfAbsent(
    userId: string,
    passwordHash: string,
    /** The request context and its already-resolved consequence. Optional so the
     *  registration path, which sets a password on an account nobody is logged into,
     *  keeps working unchanged — there is no session to classify there. */
    restriction?: { context: SecurityContext; plan: RestrictionPlan },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, userId);

      const revived = await tx.credential.updateMany({
        where: { userId, kind: 'PASSWORD', deletedAt: { not: null } },
        data: { passwordHash, failedAttempts: 0, lockedUntil: null, deletedAt: null },
      });
      if (revived.count === 1) {
        // Same commit as the credential — see `stampRestrictionsLocked`.
        if (restriction) await stampRestrictionsLocked(tx, restriction.context, restriction.plan);
        return true;
      }

      try {
        await tx.credential.create({
          data: { id: uuidv7(), userId, kind: 'PASSWORD', passwordHash },
        });
        if (restriction) await stampRestrictionsLocked(tx, restriction.context, restriction.plan);
        return true;
      } catch (err) {
        // The index is the authority. Losing to it means a live password credential
        // exists, which is precisely what this method refuses to overwrite.
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    });
  }

  /**
   * Replace an existing password credential, and refuse if there is none.
   *
   * `updateMany` rather than `update`, because `update` throws `P2005`/`P2025` when the
   * row is missing and "no password on this account" is an ordinary answer here, not an
   * exception. The count is the answer: `1` replaced, `0` had nothing to replace.
   *
   * `failedAttempts` and `lockedUntil` are cleared and `lockoutStrikes` deliberately is
   * not — matching `upsertPassword`'s update arm exactly. A successful reset should not
   * leave the account locked out by the failures that prompted it, but the strike ladder
   * is a record of how often this account has been ground against, and a password change
   * is not evidence that it has not been.
   */
  async replacePassword(
    userId: string,
    passwordHash: string,
    restriction?: { context: SecurityContext; plan: RestrictionPlan },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, userId);

      const updated = await tx.credential.updateMany({
        where: { userId, kind: 'PASSWORD', deletedAt: null },
        data: { passwordHash, failedAttempts: 0, lockedUntil: null },
      });
      // Nothing replaced means no password existed, so nothing is owed.
      if (updated.count !== 1) return false;

      // Same commit as the password. `PasswordSettingsService.finish` sweeps sessions
      // after this returns and deliberately keeps the caller's own session, so a
      // post-commit write would leave a window with the new password live and no
      // restriction applied.
      if (restriction) await stampRestrictionsLocked(tx, restriction.context, restriction.plan);
      return true;
    });
  }

  /**
   * ═══ THE ANTI-PHISHING CODE ═════════════════════════════════════════════════
   *
   * Four sealed columns on `users` plus a timestamp. They live here rather than in
   * `src/settings/antiPhishing/` because `users` is this module's table, and
   * `settings.module.ts` states the rule that a settings sub-feature must not become a
   * second access layer for another module's rows. The feature owns the policy; these
   * three methods are the only way it touches the row.
   *
   * The direction-as-authorisation argument above applies unchanged, and here it is the
   * ONLY thing standing between two concurrent `set` requests and one silently
   * overwriting the other — there is no unique index to lose to, because the columns
   * are on a row that always exists. So the precondition is a PREDICATE on the write:
   * `set` matches only a NULL ciphertext, `change`/`replace` only a non-NULL one. The
   * count is the answer, and a caller whose service-level check went stale gets the
   * same refusal it would have given a moment earlier.
   *
   * All three take the cooldown row lock first, for `upsertPassword`'s reason: the
   * service asked `RecentSecurityChangePolicy` before spending the emailed code and
   * before an AES open, and an email change can commit in between. This is the last
   * word on the freeze; see `assertChangeAllowed` in the anti-phishing service, which
   * is the seam these are paired with.
   */

  /** The sealed columns, or `null` when no code is configured. One indexed read by
   *  primary key. */
  async findAntiPhishing(userId: string): Promise<AntiPhishingColumns | null> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        antiPhishingCiphertext: true,
        antiPhishingIv: true,
        antiPhishingTag: true,
        antiPhishingKeyVersion: true,
      },
    });

    // Every column is written and cleared together, so any one of them being null means
    // "not configured". Checking all four rather than just the ciphertext is not
    // defensive padding — it is what lets the return type be non-nullable in each
    // field, so no caller downstream has to re-narrow four values it cannot use
    // separately.
    if (
      row === null ||
      row.antiPhishingCiphertext === null ||
      row.antiPhishingIv === null ||
      row.antiPhishingTag === null ||
      row.antiPhishingKeyVersion === null
    ) {
      return null;
    }

    return {
      ciphertext: row.antiPhishingCiphertext,
      iv: row.antiPhishingIv,
      tag: row.antiPhishingTag,
      keyVersion: row.antiPhishingKeyVersion,
    };
  }

  /**
   * Write the first code, and refuse if one is already set.
   *
   * `false` means "this account already has a code" — the loser of a race between two
   * concurrent `set` requests, or a stale precondition. `antiPhishingCiphertext: null`
   * in the WHERE is the entire mechanism: Postgres evaluates it under the row lock this
   * transaction already holds, so the two requests serialise and exactly one sees NULL.
   */
  async setAntiPhishingIfAbsent(userId: string, sealed: SealedValue): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, userId);

      const written = await tx.user.updateMany({
        where: { id: userId, deletedAt: null, antiPhishingCiphertext: null },
        data: {
          antiPhishingCiphertext: sealed.ciphertext,
          antiPhishingIv: sealed.iv,
          antiPhishingTag: sealed.tag,
          antiPhishingKeyVersion: sealed.keyVersion,
          antiPhishingSetAt: new Date(),
        },
      });
      return written.count === 1;
    });
  }

  /**
   * Replace an existing code, and refuse if there is none.
   *
   * `antiPhishingSetAt` is deliberately NOT touched — it records when the account first
   * set a code, which is `PaymentPin.createdAt`'s reason for surviving an update. The
   * record of a CHANGE is the security-changed email and the log line.
   */
  async replaceAntiPhishing(userId: string, sealed: SealedValue): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, userId);

      const updated = await tx.user.updateMany({
        where: { id: userId, deletedAt: null, antiPhishingCiphertext: { not: null } },
        data: {
          antiPhishingCiphertext: sealed.ciphertext,
          antiPhishingIv: sealed.iv,
          antiPhishingTag: sealed.tag,
          antiPhishingKeyVersion: sealed.keyVersion,
        },
      });
      return updated.count === 1;
    });
  }

  /**
   * Move a row onto the active key, without changing the code it holds.
   *
   * The drain half of key rotation, called unawaited from the mail path when
   * `needsReseal` says a row is on a retired version. Three properties, and each is
   * deliberate:
   *
   * NO COOLDOWN LOCK. This is not a security change — the plaintext is identical before
   * and after, and refusing it during a freeze would strand exactly the rows a rotation
   * needs to drain. It is maintenance, and `assertNoRecentEmailChangeLocked` guards
   * changes of INTENT.
   *
   * PREDICATED ON `fromVersion`. Two concurrent resealings of one row, or a reseal
   * racing a legitimate `change`, must not clobber a newer envelope with an older one.
   * Matching the version this reseal was computed from means the loser writes nothing.
   *
   * NO RETURN VALUE WORTH ACTING ON. `false` is the ordinary outcome of losing that
   * race and of the code having been changed meanwhile, and both are fine — the row is
   * on a good key either way. The caller ignores it.
   */
  async resealAntiPhishing(
    userId: string,
    sealed: SealedValue,
    fromVersion: number,
  ): Promise<boolean> {
    const updated = await this.prisma.user.updateMany({
      where: {
        id: userId,
        deletedAt: null,
        antiPhishingCiphertext: { not: null },
        antiPhishingKeyVersion: fromVersion,
      },
      data: {
        antiPhishingCiphertext: sealed.ciphertext,
        antiPhishingIv: sealed.iv,
        antiPhishingTag: sealed.tag,
        antiPhishingKeyVersion: sealed.keyVersion,
      },
    });
    return updated.count === 1;
  }

  /**
   * Record a failed attempt and lock once the threshold is crossed.
   *
   * The increment is done by the database (`{ increment: 1 }`), not by reading
   * and writing back, so concurrent attempts cannot both read the same count and
   * each store `n + 1`. Two racing requests can both observe the threshold and
   * both write the lock, which is harmless — the write is idempotent.
   *
   * `lockUntil` is computed by the caller and passed in: this layer holds no
   * policy.
   */
  async registerFailedAttempt(
    credentialId: string,
    maxAttempts: number,
    /** Chooses the penalty from the strike count the caller is about to reach. All
     *  policy — the ladder, its memory — lives in the caller. */
    lockFor: (strike: number) => Date,
    /** Strikes older than this are forgotten, so one bad week does not sentence an
     *  account to a day-long lock a year later. */
    strikeTtlSeconds: number,
  ): Promise<{ locked: boolean; lockedUntil: Date | null }> {
    const updated = await this.prisma.credential.update({
      where: { id: credentialId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true, lockoutStrikes: true, lockoutStrikeAt: true },
    });

    if (updated.failedAttempts < maxAttempts) return { locked: false, lockedUntil: null };

    // The ladder's memory decays from the NEWEST strike. A previous strike older
    // than the window is forgotten, so this lock starts again at rung one — which is
    // what keeps an account that had one bad afternoon a year ago from being handed
    // a twenty-four-hour lock today.
    const previous =
      updated.lockoutStrikeAt !== null &&
      Date.now() - updated.lockoutStrikeAt.getTime() < strikeTtlSeconds * 1000
        ? updated.lockoutStrikes
        : 0;

    const strike = previous + 1;
    const lockedUntil = lockFor(strike);

    await this.prisma.credential.update({
      where: { id: credentialId },
      data: {
        lockedUntil,
        failedAttempts: 0,
        lockoutStrikes: strike,
        lockoutStrikeAt: new Date(),
      },
    });

    return { locked: true, lockedUntil };
  }

  /**
   * Clear the lockout state after a successful sign-in.
   *
   * The strike count goes too, and that is a deliberate product call rather than an
   * oversight. A correct password is proof the caller is the owner, and carrying a
   * ladder rung forward past that would mean a user who genuinely forgot their
   * password twice in a year met an hour-long lock the third time — punishing
   * forgetfulness rather than the attack the ladder exists for. An attacker who never
   * guesses right never reaches this path.
   */
  async clearFailedAttempts(credentialId: string): Promise<void> {
    await this.prisma.credential.update({
      where: { id: credentialId },
      data: {
        failedAttempts: 0,
        lockedUntil: null,
        lockoutStrikes: 0,
        lockoutStrikeAt: null,
      },
    });
  }

  // ─── oauth links ──────────────────────────────────────────────────────────

  async findOauthLink(provider: OauthProvider, subject: string) {
    return this.prisma.oauthLink.findFirst({
      where: { provider, subject, deletedAt: null },
      include: { user: true },
    });
  }

  /**
   * Every live provider identity attached to one account.
   *
   * The first reader of `@@index([userId])`, which was declared with the table and
   * has had no caller until now: the OAuth flows all arrive holding a
   * `(provider, subject)` pair and ask the question from the other direction. This
   * is what `GET /settings/security/social-accounts` renders, and what the
   * one-link-per-provider rule is checked against.
   *
   * `deletedAt: null` because unlinking is a soft delete — a retired row must not
   * appear on the settings screen, and must not make a provider look occupied.
   *
   * Ordered by `linkedAt` so the screen is stable across reloads rather than
   * reflecting whatever order Postgres found the rows in.
   */
  async listOauthLinks(userId: string) {
    return this.prisma.oauthLink.findMany({
      where: { userId, deletedAt: null },
      orderBy: { linkedAt: 'asc' },
    });
  }

  async touchOauthLogin(linkId: string): Promise<void> {
    await this.prisma.oauthLink.update({
      where: { id: linkId },
      data: { lastLoginAt: new Date() },
    });
  }

  // ─── the delayed unlink ───────────────────────────────────────────────────
  //
  // Four conditional updates and one read. None takes a transaction and none takes a
  // lock, which is the point: each is a single `UPDATE ... WHERE`, atomic on its own,
  // and every one of them states in its predicate the condition it depends on rather
  // than trusting a value read a moment earlier. That is the same compare-and-swap
  // discipline `claimTotpStep` uses, and it is what makes a second browser tab, a
  // retried sweep and a relink-during-the-window all safe without coordination.

  /**
   * Stamp the waiting period onto a live link that is not already counting down.
   *
   * `unlinkAt: null` in the predicate is the compare-and-swap. Two tabs clicking
   * Unlink race here, and the loser must not push the winner's deadline further out —
   * so the loser matches nothing, learns it lost from the count, and reports the
   * deadline that was actually set.
   */
  async scheduleOauthUnlink(id: string, unlinkAt: Date): Promise<boolean> {
    const scheduled = await this.prisma.oauthLink.updateMany({
      where: { id, deletedAt: null, unlinkAt: null },
      data: { unlinkRequestedAt: new Date(), unlinkAt },
    });
    return scheduled.count === 1;
  }

  /**
   * Take back a pending unlink.
   *
   * One caller, and deliberately only one: re-linking the SAME provider identity.
   * There is no cancel endpoint, so this is not reachable by naming a provider — the
   * caller must complete a provider round trip as the account that is counting down.
   */
  async cancelOauthUnlink(id: string): Promise<boolean> {
    const cancelled = await this.prisma.oauthLink.updateMany({
      where: { id, deletedAt: null, unlinkAt: { not: null } },
      data: { unlinkRequestedAt: null, unlinkAt: null },
    });
    return cancelled.count === 1;
  }

  /**
   * Live links whose waiting period has run out.
   *
   * `take` because a sweep must not load an unbounded result set; ordered by deadline
   * so the longest-overdue are retired first if a backlog ever forms.
   */
  async listDueOauthUnlinks(now: Date, take: number): Promise<OauthLink[]> {
    return this.prisma.oauthLink.findMany({
      where: { deletedAt: null, unlinkAt: { lte: now } },
      orderBy: { unlinkAt: 'asc' },
      take,
    });
  }

  /**
   * Retire one due link.
   *
   * Every condition is re-checked here rather than carried over from the sweep's
   * unlocked read, which is what makes the operation safe to repeat and impossible to
   * aim at the wrong row. A link cancelled since that read no longer has an
   * `unlinkAt`; one already retired no longer has a null `deletedAt`; and a provider
   * re-linked since is a DIFFERENT row with a different id. All three miss.
   */
  async retireDueOauthLink(id: string, now: Date): Promise<boolean> {
    const retired = await this.prisma.oauthLink.updateMany({
      where: { id, deletedAt: null, unlinkAt: { lte: now } },
      data: { deletedAt: now },
    });
    return retired.count === 1;
  }

  // ─── deleting the account ─────────────────────────────────────────────────
  //
  // Three conditional updates, one read and one transaction, following the delayed
  // unlink above: every predicate restates the condition it depends on, so a second
  // tab, a retried sweep and a delete/reactivate race are all safe without
  // coordination.
  //
  // The one departure is `purgeAccount`, which IS a transaction — it writes fourteen
  // tables and a half-applied purge would leave an account with some of its
  // credentials destroyed and some intact. That is the multi-row case the repository
  // reserves transactions for.

  /**
   * Move a live account into the recovery window.
   *
   * `status: 'ACTIVE'` in the predicate is the compare-and-swap, and it carries two
   * races at once: two tabs clicking Delete, and a delete arriving after a purge. The
   * loser matches nothing and reports the deadline that was actually set, exactly as
   * `scheduleOauthUnlink` does.
   *
   * `deletedAt: null` is belt-and-braces rather than redundancy — `status` and
   * `deletedAt` are written by different callers (this and the sweep), so a predicate
   * naming only one of them would be a predicate that trusts the other to agree.
   *
   * Note what is NOT written: `deletedAt`. Leaving it null is what keeps the account's
   * email, username and public code reserved through the window, which is the only
   * reason a reactivation can be guaranteed to succeed. See `User.deletedAt`.
   */
  async requestAccountDeletion(
    userId: string,
    deletionRequestedAt: Date,
    purgeAt: Date,
  ): Promise<boolean> {
    const requested = await this.prisma.user.updateMany({
      where: { id: userId, status: 'ACTIVE', deletedAt: null, purgeAt: null },
      data: { status: 'DELETED', deletionRequestedAt, purgeAt },
    });
    return requested.count === 1;
  }

  /**
   * Bring a deleted account back, if its window is still open.
   *
   * ═══ THE RECOVERY WINDOW IS ENFORCED HERE AND NOWHERE ELSE ══════════════════
   *
   * `purgeAt: { gt: now }` is the whole boundary check. It is in the WHERE clause
   * rather than in a service-level `if` on purpose: a read-then-write would leave a
   * gap in which the sweep could purge the account between the check and the update,
   * and the reactivation would then resurrect a row whose data had just been
   * destroyed. Stated as a predicate, the two operations are mutually exclusive by
   * construction — the sweep's precondition is `purgeAt <= now` and this one is
   * `purgeAt > now`, so exactly one of them can ever match.
   *
   * `deletedAt: null` is the other half of that guarantee and covers the case where
   * the sweep has already finished: a purged row can never match this, so there is no
   * arrangement of timings that reactivates an account whose credentials are gone.
   *
   * A `false` here is deliberately ambiguous between "never deleted", "already
   * reactivated" and "window closed". The caller cannot distinguish them and must not
   * — see the public reactivation route.
   */
  async reactivateAccount(userId: string, now: Date): Promise<boolean> {
    const reactivated = await this.prisma.user.updateMany({
      where: { id: userId, status: 'DELETED', deletedAt: null, purgeAt: { gt: now } },
      data: { status: 'ACTIVE', deletionRequestedAt: null, purgeAt: null },
    });
    return reactivated.count === 1;
  }

  /**
   * Accounts whose recovery window has run out.
   *
   * `take` because a sweep must not load an unbounded result set; ordered by deadline
   * so the longest-overdue go first if a backlog forms. Served by `ix_users_purge_due`
   * in db/sql/identity.sql, whose partial predicate is exactly this WHERE.
   */
  async listDuePurges(now: Date, take: number): Promise<User[]> {
    return this.prisma.user.findMany({
      where: { status: 'DELETED', deletedAt: null, purgeAt: { lte: now } },
      orderBy: { purgeAt: 'asc' },
      take,
    });
  }

  /**
   * Destroy one due account's data. The terminal step.
   *
   * ═══ THIS IS A TRUE HARD DELETE ═════════════════════════════════════════════
   *
   * The `users` row is physically removed. There is no tombstone, no terminal status
   * and nothing left to scrub: after this commits the account does not exist in the
   * data model at all, every lookup misses because there is no row rather than because
   * a predicate filtered one, and reactivation is impossible rather than merely
   * refused. The ABSENCE of the row is the hard-deleted state.
   *
   * That is the product requirement — thirty days of recovery, then complete removal —
   * and it is also the only representation of "purged" that cannot be confused with
   * "recoverable" by a future reader or a future query.
   *
   * ─── What the cascade does, and why it is trusted here ──────────────────────
   *
   * Every foreign key into `identity.users` is ON DELETE CASCADE except two, verified
   * against the live database rather than read off the schema. So one DELETE removes
   * credentials, TOTP factors, passkeys, recovery codes, the Payment PIN, OAuth links,
   * trusted devices, verification challenges, retained emails, username reservations,
   * login attempts and sessions.
   *
   * Leaning on the constraint is deliberate and is the safer of the two options. An
   * explicit `deleteMany` per table is a second copy of the schema, and a child table
   * added later would silently fall out of it and leave orphans nobody notices. With
   * the cascade, a table added later WITHOUT one makes this statement throw a
   * foreign-key violation: the purge fails loudly, the transaction rolls back, and the
   * account stays due for the next sweep rather than ending up half-deleted.
   *
   * ─── The two things a cascade cannot reach ──────────────────────────────────
   *
   * `registrations.user_id` is SET NULL, not CASCADE, because a registration is history
   * and history is kept — so the row outlives the user and has to be scrubbed in place.
   * `mail_deliveries` has no foreign key at all; it is keyed by recipient, so it is
   * reached by VALUE, by `scrubMailDeliveries`, using the address set collected here
   * before anything is destroyed.
   *
   * Anonymous `login_attempts` are a third case hiding inside the first: the FK cascades
   * only the rows that HAVE a `userId`, and that column is written only after a first
   * factor succeeds. The failed and abandoned attempts carry the identifier and no
   * `userId`, so they are deleted explicitly.
   *
   * ─── Sessions go too ────────────────────────────────────────────────────────
   *
   * `Session` carries `ipClass`, `userAgent` and `deviceFingerprint`, which are
   * user-derived. The schema notes that a revoked session "is kept forever and stays
   * queryable", but that is a naming rationale — it explains why the column is
   * `revokedAt` and not `deletedAt`, i.e. that revocation is not a soft delete. It is
   * not a retention requirement, and nothing in this repository states one: a
   * repository-wide search for a legal, statutory or compliance obligation finds
   * nothing. The schema itself says the opposite, in the only way a schema can — the FK
   * is CASCADE.
   *
   * So they are deleted with the account. Retaining user-derived data for convenience
   * is exactly what the deletion promise rules out.
   *
   * ─── All of it, or none of it ───────────────────────────────────────────────
   *
   * The claim and the destruction are one transaction, which is the only arrangement
   * that is safe to interrupt. A partial purge must not be reachable in either
   * direction:
   *
   *   claim committed, deletes lost  →  a row marked purged, invisible to
   *     `listDuePurges` because that filters `deletedAt: null`, with every credential
   *     still on disk and nothing that would ever look at it again.
   *
   *   deletes committed, claim lost  →  an account still live to every lookup whose
   *     password and factors have been destroyed.
   *
   * Both are unreachable: a rollback leaves the account exactly as due as it was and the
   * next sweep repeats the whole thing, and a commit takes the row with it so there is
   * nothing left to repeat the purge against.
   */
  async purgeAccount(userId: string, now: Date): Promise<readonly string[] | null> {
    return this.prisma.$transaction(async (tx) => {
      // ─── claim the row, and serialise against a reactivation ───────────────
      //
      // A conditional UPDATE rather than a bare read, because it does two jobs at once:
      // it re-states every precondition (the sweep's read was unlocked and a
      // reactivation may have landed since), and it takes the row lock that makes this
      // transaction and a concurrent reactivation mutually exclusive.
      //
      // The `deletedAt` it writes never reaches disk — the row is DELETED below, in
      // this same transaction. It is a claim, not a tombstone. A second sweeping
      // instance blocks here until this transaction commits, then matches no rows
      // because the account is gone, and stops without touching anything.
      const claimed = await tx.user.updateMany({
        where: { id: userId, status: 'DELETED', deletedAt: null, purgeAt: { lte: now } },
        data: { deletedAt: now },
      });
      if (claimed.count !== 1) return null;

      // ─── every identifier this account has ever answered to ───────────────
      //
      // Read BEFORE anything is destroyed, because two of the things below are reached
      // by VALUE rather than by relation and the rows that name those values are about
      // to disappear.
      //
      // `retained_emails` is the record of addresses this account has RELEASED by
      // changing its email, and `registrations` holds the address of every signup
      // attempt — including the abandoned ones, which never got a `userId` because
      // `createAccount` sets that only on the attempt that completed. Deleting the user
      // first, then scrubbing "the account's address", would leave the released
      // addresses both un-scrubbed and unlocatable.
      const owner = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true, emailLower: true, usernameLower: true, publicCodeKey: true },
      });
      const released = await tx.retainedEmail.findMany({
        where: { userId },
        select: { email: true, emailLower: true },
      });
      const attempted = await tx.registration.findMany({
        where: { OR: [{ userId }, { emailLower: owner.emailLower }] },
        select: { id: true, email: true, emailLower: true },
      });

      // Deduplicated, and both forms of each address kept. `MailDelivery.recipient` is
      // stored AS SENT and deliberately not lowercased, while `emailLower` is
      // normalised — and the two genuinely differ on the OAuth path, where `User.email`
      // takes the provider's value verbatim. Matching on only one form would silently
      // scrub nothing for exactly those accounts.
      const recipients = [
        ...new Set(
          [
            owner.email,
            owner.emailLower,
            ...released.flatMap((row) => [row.email, row.emailLower]),
            ...attempted.flatMap((row) => [row.email, row.emailLower]),
          ].filter((value) => value.length > 0),
        ),
      ];

      // ─── what the cascade cannot reach ─────────────────────────────────────
      //
      // Sign-in attempts that were never tied to the account. `LoginAttempt.userId`
      // cascades, but it has exactly one writer — `promoteAttempt` — and that runs only
      // AFTER a first factor has succeeded. So every mistyped password, every abandoned
      // sign-in and every OTP flow the user never finished leaves a row with `userId`
      // NULL and `identifierLower` holding the address, username or public code they
      // typed, beside the network class and the user agent. The FK does not see those
      // rows, and nothing else ever removes them — this table has no retention sweep.
      await tx.loginAttempt.deleteMany({
        where: {
          OR: [
            { userId },
            { identifierLower: { in: [owner.emailLower, owner.usernameLower, owner.publicCodeKey] } },
          ],
        },
      });

      // Registration rows SURVIVE the user, by schema: `registrations.user_id` is
      // ON DELETE SET NULL, not CASCADE, because a registration is history and history
      // is kept. The row therefore has to be scrubbed in place — a cascade would never
      // reach it, and after the delete below there is no `userId` left to find it by.
      //
      // Addressed by id, from the read above, so this covers the abandoned attempts
      // that never carried a `userId` as well as the one that completed.
      await tx.registration.updateMany({
        where: { id: { in: attempted.map((row) => row.id) } },
        data: {
          email: PURGED_EMAIL,
          emailLower: PURGED_EMAIL,
          ipAddress: PURGED_IP,
          pendingPasswordHash: null,
          continuationSecretHash: null,
          otpHash: null,
          oauthSubject: null,
          // The provider's profile photo — the value `User.avatarUrl` was copied FROM
          // at account creation. Letting the account go while keeping this would retain
          // a fetchable picture of the person on a row that outlives them by design.
          oauthAvatarUrl: null,
          oauthProvider: null,
          referralCodeEntered: null,
          countrySuggested: null,
          country: null,
        },
      });

      // ─── and then the account itself ───────────────────────────────────────
      //
      // A real DELETE. There is no tombstone and no terminal status: the absence of the
      // row IS the hard-deleted state, which is the only representation that cannot be
      // mistaken for a recoverable one and the only one that leaves nothing to scrub.
      //
      // This cascades. Verified against the live database rather than assumed — every
      // foreign key into `identity.users` is ON DELETE CASCADE except the two SET NULLs
      // handled above:
      //
      //   credentials · totp_factors · passkeys · recovery_codes · payment_pins
      //   oauth_links · trusted_devices · verification_challenges · retained_emails
      //   username_reservations · login_attempts · sessions
      //   user_feature_restrictions
      //
      // `user_feature_restrictions` goes with the account, and the asymmetry is the
      // point: a DELETED account inside its recovery window keeps its restrictions, so
      // deleting and reactivating cannot be used to shed one. Only the purge — which is
      // terminal and leaves no account to restrict — removes them.
      //
      // Deliberately NOT a list of explicit `deleteMany` calls ahead of it. An explicit
      // list is a second copy of the schema that a new child table would silently fall
      // out of, leaving orphaned rows nobody notices. Leaning on the constraint inverts
      // that failure: a future table added WITHOUT a cascade makes this statement throw
      // a foreign-key violation, which fails the purge loudly and leaves the account due
      // for the next sweep rather than half-deleted and unreachable.
      //
      // `sessions` goes with it, and that is a decision rather than a side effect — see
      // the note on this method.
      await tx.user.delete({ where: { id: userId } });

      return recipients;
    });
  }

  /**
   * Blank the delivery log for every address a purged account ever answered to.
   *
   * Separate from `purgeAccount` and outside its transaction, because `mail_deliveries`
   * has no foreign key to `users` at all — it is keyed by recipient, deliberately, so
   * that a code sent before an account existed still has a record. That makes it the
   * one table a purge reaches by VALUE rather than by relation, and the one whose
   * failure must not roll back a purge that otherwise succeeded.
   *
   * ─── Why a LIST, and why both forms of each address ────────────────────────
   *
   * An account that changed its email has delivery rows for every address it has held —
   * the registration code, the welcome mail, and specifically the "your address was
   * changed" notice, which is sent TO the address being released. Scrubbing only the
   * current address would leave all of those, and the retention rows that record what
   * they were are deleted by the purge itself. `purgeAccount` therefore collects the
   * whole set before it destroys anything and hands it here.
   *
   * `mode: 'insensitive'` because `recipient` is stored AS SENT and deliberately not
   * lowercased, while the account's `emailLower` is normalised. On the OAuth path those
   * two genuinely differ — `User.email` takes the provider's value verbatim — so an
   * exact match would silently scrub zero rows for precisely those accounts.
   *
   * The rows are kept and only the address is overwritten: this is the delivery audit
   * trail, and "a message was sent at 14:02 and bounced" stays true and useful once the
   * recipient is no longer identifiable.
   */
  async scrubMailDeliveries(recipients: readonly string[]): Promise<number> {
    if (recipients.length === 0) return 0;

    // One statement per address rather than an `in`, because case-insensitive matching
    // is per-value in Prisma. The list is small — one current address plus one per
    // address ever released — and this runs once per purged account.
    let scrubbed = 0;
    for (const recipient of recipients) {
      const { count } = await this.prisma.mailDelivery.updateMany({
        where: { recipient: { equals: recipient, mode: 'insensitive' } },
        data: { recipient: PURGED_EMAIL },
      });
      scrubbed += count;
    }
    return scrubbed;
  }

  /**
   * Attach a provider identity to an account that already exists.
   *
   * The counterpart to the link written inside `createAccount`, and for a long
   * time the missing half: a link could only be created at the moment an account
   * was born, so a user whose provider email matched their account had no way to
   * connect the two.
   *
   * Deliberately not an upsert. Uniqueness on `(provider, subject)` is a partial
   * index in db/sql/identity.sql, which Prisma cannot see and therefore cannot
   * target with `where` — an upsert would compile and then fail at runtime. The
   * insert raises 23505 instead, which `isUniqueViolation` recognises and the
   * caller turns into `oauth_already_linked`.
   */
  async linkOauth(
    userId: string,
    input: {
      provider: OauthProvider;
      subject: string;
      emailAtLink: string;
      emailVerifiedByProvider: boolean;
      avatarUrl?: string | null;
      /**
       * The display name the provider asserted, for the settings screen to show.
       *
       * OPTIONAL, and that is what keeps this method's existing callers untouched.
       * `POST /auth/link` and account creation both omit it and write null, exactly
       * as they did before the column existed; only the Settings link path supplies
       * one. Making it required would have meant editing `attachPending`, which is
       * on the protected `/auth/link` path.
       *
       * Null is a real answer rather than a gap to fill later: Apple publishes no
       * name in the ID token and no endpoint to fetch one.
       */
      nameAtLink?: string | null;
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.oauthLink.create({
        data: {
          id: uuidv7(),
          userId,
          provider: input.provider,
          subject: input.subject,
          emailAtLink: input.emailAtLink,
          emailVerifiedByProvider: input.emailVerifiedByProvider,
          avatarUrlAtLink: input.avatarUrl ?? null,
          nameAtLink: input.nameAtLink ?? null,
          lastLoginAt: new Date(),
        },
      });

      if (input.avatarUrl) {
        // If the user does not have an avatar yet, backfill with the newly linked OAuth avatar
        await tx.user.updateMany({
          where: { id: userId, avatarUrl: null },
          data: { avatarUrl: input.avatarUrl },
        });
      }
    });
  }
}
