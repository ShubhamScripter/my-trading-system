import { Injectable } from '@nestjs/common';
import type {
  LoginAttempt,
  LoginState,
  Passkey,
  RecoveryCode,
  TotpFactor,
} from '@prisma/client';
import { PrismaService } from '../../db/client';
import { assertNoRecentEmailChangeLocked } from '../../auth/persistence/security-cooldown.lock';
import { stampRestrictionsLocked } from '../../auth/persistence/restriction.lock';
import type { RestrictionPlan, SecurityContext } from '../restrictions/restrictions.types';
import { uuidv7 } from '../utils/public.utils';

/**
 * Persistence for the four second-factor tables.
 *
 * One dboperation rather than four, because the four tables are one feature and
 * every interesting question spans them — "does this account have a factor at all"
 * reads three of them, and confirming a TOTP factor writes recovery codes in the
 * same breath. Splitting them would put those transactions in a service, which is
 * the one place this codebase does not allow a `prisma` call.
 *
 * The compare-and-swap methods below (`claimTotpStep`, `spendRecoveryCode`,
 * `completeAttempt`, `chargeAttempt`) are the load-bearing ones. Each is a single
 * conditional UPDATE rather than a read followed by a write, because each is
 * exactly the place two concurrent requests presenting the same credential must
 * not both succeed.
 */
@Injectable()
export class TwoFactorDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // ─── TOTP ─────────────────────────────────────────────────────────────────

  /** Every live factor for a user, confirmed or not. */
  async listTotpFactors(userId: string): Promise<TotpFactor[]> {
    return this.prisma.totpFactor.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** The confirmed factors — the ones that actually satisfy a sign-in. */
  async listConfirmedTotpFactors(userId: string): Promise<TotpFactor[]> {
    return this.prisma.totpFactor.findMany({
      where: { userId, deletedAt: null, confirmedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * The pending enrollment, if one is waiting to be confirmed.
   *
   * Newest first: starting enrollment again before finishing supersedes the
   * previous attempt rather than erroring, because the ordinary way to reach that
   * state is scanning a QR code, closing the tab, and starting over.
   */
  async findPendingTotpFactor(userId: string): Promise<TotpFactor | null> {
    return this.prisma.totpFactor.findFirst({
      where: { userId, deletedAt: null, confirmedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findTotpFactor(id: string, userId: string): Promise<TotpFactor | null> {
    // `userId` in the predicate, not checked afterwards: ids are time-ordered
    // UUIDv7 and therefore guessable from a neighbouring one, so ownership belongs
    // in the query rather than in a conditional a caller can forget.
    return this.prisma.totpFactor.findFirst({ where: { id, userId, deletedAt: null } });
  }

  /**
   * `id` is supplied by the caller rather than generated here, which is the one place
   * in this file that happens.
   *
   * The envelope is bound to `(userId, id)` as GCM additional authenticated data, so
   * the id has to exist BEFORE the secret is sealed — a row cannot be created and
   * then have its secret bound to it afterwards without a second write. Handing the
   * id in keeps enrollment one insert, and it is why `sealSecret` takes the factor id
   * as a required argument.
   */
  async createTotpFactor(input: {
    id: string;
    userId: string;
    // `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, because that is
    // exactly what Prisma's `Bytes` resolves to and the two are not
    // interchangeable: a bare one also admits a SharedArrayBuffer backing store,
    // which the driver cannot accept.
    secretCiphertext: Uint8Array<ArrayBuffer>;
    secretIv: Uint8Array<ArrayBuffer>;
    secretTag: Uint8Array<ArrayBuffer>;
    keyVersion: number;
    label: string;
  }): Promise<TotpFactor> {
    // Transactional for the security cooldown — see the note above `createPasskey`.
    // Guarded even though the row lands unconfirmed and proves nothing on its own:
    // `totp-confirm` needs no elevation ticket, so a pending row written during a
    // freeze is a row a bare access token could turn into a real factor the moment the
    // freeze lifts. The two enrollment halves are frozen together or not at all.
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, input.userId);

      return tx.totpFactor.create({ data: input });
    });
  }

  /**
   * Re-seal a factor's secret under the current envelope version.
   *
   * Called opportunistically after a v1 row verifies, so the old unbound format
   * drains without a backfill and without a window in which a user cannot sign in.
   * The `keyVersion` predicate makes it a compare-and-swap: two concurrent
   * verifications cannot both re-seal, and the loser's write matching zero rows is
   * the correct outcome rather than an error.
   */
  async resealTotpSecret(
    id: string,
    fromVersion: number,
    sealed: {
      secretCiphertext: Uint8Array<ArrayBuffer>;
      secretIv: Uint8Array<ArrayBuffer>;
      secretTag: Uint8Array<ArrayBuffer>;
      keyVersion: number;
    },
  ): Promise<boolean> {
    const resealed = await this.prisma.totpFactor.updateMany({
      where: { id, keyVersion: fromVersion, deletedAt: null },
      data: sealed,
    });
    return resealed.count === 1;
  }

  /**
   * Claim a TOTP time step for one factor, or refuse.
   *
   * ─── The replay defence, and why it is a CAS ───────────────────────────────
   *
   * A six-digit code stays arithmetically valid for the ~90 seconds the acceptance
   * window covers, so a code read over a shoulder or captured in transit is usable
   * more than once unless something says otherwise. This is that something: the
   * step of the last accepted code is stored, and any step at or below it is
   * refused.
   *
   * `lastUsedStep: { lt: step }` in the WHERE is what makes it safe under
   * concurrency. Read-then-write would let two requests carrying the same code both
   * observe the old value and both pass — which is precisely the race a replay is.
   * Here the second finds zero rows and gets `false`.
   *
   * The `OR` on null covers the first use of a freshly confirmed factor, which has
   * no previous step.
   */
  async claimTotpStep(factorId: string, step: bigint): Promise<boolean> {
    const claimed = await this.prisma.totpFactor.updateMany({
      where: {
        id: factorId,
        deletedAt: null,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
      },
      data: { lastUsedStep: step, lastUsedAt: new Date() },
    });
    return claimed.count === 1;
  }

  /**
   * Confirm a factor and write the recovery codes it earns, atomically.
   *
   * One transaction because a user must never end up with a live factor and no way
   * back from it. If the codes were written separately and that write failed, the
   * account would be locked behind an authenticator with no recovery — the exact
   * situation recovery codes exist to prevent.
   *
   * `codeHashes` is empty when the account already has codes, so re-confirming a
   * second factor does not silently invalidate the set the user has written down.
   *
   * ─── Why the update count decides whether the codes are written ────────────
   *
   * Because it is the compare-and-swap, and ignoring it was a real bug. The
   * `confirmedAt: null` predicate was already here, but its `count` was never read —
   * the only method in this file that didn't. Two concurrent confirmations of the
   * same pending factor therefore both proceeded: each observed no existing recovery
   * codes, each generated a set, the loser's `updateMany` matched zero rows, and its
   * `createMany` ran anyway. The account ended up with TWENTY live recovery codes,
   * two different plaintext sets handed to two responses, every one of them valid for
   * sign-in, and `recoveryCodesRemaining` reporting 20. There is no unique constraint
   * on `recovery_codes` to have caught it.
   *
   * Returning `false` rather than throwing keeps this layer free of HTTP semantics;
   * the caller turns it into `MFA_ALREADY_ENROLLED`. The loser gets no codes, which
   * is the point — only the request that actually confirmed the factor may mint the
   * set that backs it up.
   */
  async confirmTotpFactor(
    factorId: string,
    userId: string,
    codeHashes: readonly string[],
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // Before the compare-and-swap: this is the write that makes the factor real and
      // mints the account's recovery codes, so it is the one an email-change race must
      // not slip past. See `assertNoRecentEmailChangeLocked`.
      await assertNoRecentEmailChangeLocked(tx, userId);

      const confirmed = await tx.totpFactor.updateMany({
        where: { id: factorId, userId, deletedAt: null, confirmedAt: null },
        data: { confirmedAt: new Date() },
      });

      // Lost the swap: something else confirmed this factor between our read and this
      // write. Return before inserting anything — the winner has already written, or
      // is about to write, the one set that belongs to this factor.
      if (confirmed.count !== 1) return false;

      if (codeHashes.length > 0) {
        await tx.recoveryCode.createMany({
          data: codeHashes.map((codeHash) => ({ id: uuidv7(), userId, codeHash })),
        });
      }

      return true;
    });
  }

  async softDeleteTotpFactor(id: string, userId: string): Promise<boolean> {
    const removed = await this.prisma.totpFactor.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return removed.count === 1;
  }

  /**
   * Retire every authenticator on the account, confirmed or not.
   *
   * Returns a count, not a boolean, for the same reason `softDeleteAllPasskeys`
   * does: `softDeleteTotpFactor` answers "did the id you named exist", which is a
   * question about a caller-supplied id and must refuse when the answer is no. This
   * answers "how many were live", and a caller disabling an already-disabled setting
   * has asked for a state that is now true.
   *
   * ─── Why the predicate is NOT narrowed to confirmed rows ───────────────────
   *
   * It is tempting, because "disable the authenticator" sounds like it concerns the
   * confirmed factor and an unconfirmed row grants nothing on its own. Narrowing it
   * would open a way back in.
   *
   * `TWO_FACTOR_REQUIRES['totp-confirm']` is `'bearer'` — no elevation ticket — and
   * an unconfirmed `TotpFactor` row is DURABLE, unlike a passkey registration
   * challenge, which lives in Redis behind a TTL and is read with `GETDEL`. So a
   * pending row that survives a disable is a row a bare access token can confirm
   * later, re-enabling the authenticator without presenting any of the four proof
   * paths the disable exists to require.
   *
   * The sweep is therefore total. `tests/settings/settings.service.spec.ts` asserts
   * `findPendingTotpFactor` is `null` afterwards, so narrowing this fails there.
   */
  async softDeleteAllTotpFactors(
    userId: string,
    /** The request context and its already-resolved consequence. Values, not
     *  collaborators — see `stampRestrictionsLocked`. */
    context: SecurityContext,
    plan: RestrictionPlan,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, userId);

      const removed = await tx.totpFactor.updateMany({
        where: { userId, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // Same commit as the removal. `SettingsService.disableFactor` sweeps sessions
      // AFTER this returns and deliberately keeps the CALLER's session alive, so a
      // restriction written post-commit would be missing during exactly the window in
      // which the person who just removed the factor is still signed in.
      await stampRestrictionsLocked(tx, context, plan);
      return removed.count;
    });
  }

  async renameTotpFactor(id: string, userId: string, label: string): Promise<boolean> {
    const renamed = await this.prisma.totpFactor.updateMany({
      where: { id, userId, deletedAt: null },
      data: { label },
    });
    return renamed.count === 1;
  }

  // ─── passkeys ─────────────────────────────────────────────────────────────

  async listPasskeys(userId: string): Promise<Passkey[]> {
    return this.prisma.passkey.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findPasskeyByCredentialId(credentialId: string, userId: string): Promise<Passkey | null> {
    return this.prisma.passkey.findFirst({ where: { credentialId, userId, deletedAt: null } });
  }

  async findPasskey(id: string, userId: string): Promise<Passkey | null> {
    return this.prisma.passkey.findFirst({ where: { id, userId, deletedAt: null } });
  }

  async createPasskey(input: {
    userId: string;
    credentialId: string;
    publicKey: Uint8Array<ArrayBuffer>;
    signCount: bigint;
    transports: string[];
    aaguid: string | null;
    label: string;
  }): Promise<Passkey> {
    // ─── Why a transaction for one insert ─────────────────────────────────────
    //
    // The security cooldown. The calling service has already asked
    // `RecentSecurityChangePolicy`, but that check ran before a WebAuthn verification,
    // and an email change committing in between would leave a passkey enrolled moments
    // after the address moved. `assertNoRecentEmailChangeLocked` locks the account row,
    // which serialises this against `RetainedEmailDbOperation.changeEmail`.
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, input.userId);

      return tx.passkey.create({ data: { id: uuidv7(), ...input } });
    });
  }

  /**
   * Record a successful assertion, and never move the counter backwards.
   *
   * Bookkeeping — the sign-in has already been decided by the time this runs, so it
   * must not be able to fail it. `updateMany` matching zero rows is therefore the
   * correct outcome for a stale write, not an error.
   *
   * ─── Why the predicate is three clauses and not one ────────────────────────
   *
   * It used to be `where: { id }` alone, which is wrong three times over:
   *
   *  - No `signCount` bound, so two concurrent assertions could land in either
   *    order and leave the OLDER counter stored. WebAuthn's clone detection is
   *    "did the counter fail to advance", so a blind overwrite quietly weakens the
   *    one signal that would notice a duplicated authenticator. `claimTotpStep`
   *    in this same file exists to make exactly this kind of write race-safe.
   *  - No `userId`, so the only thing stopping a cross-account write was that the
   *    caller happened to have looked the row up correctly.
   *  - No `deletedAt: null`, unlike every sibling here, so a revoked passkey could
   *    still have its counter and `lastUsedAt` refreshed — which would make a
   *    removed credential look recently used in the factor list.
   *
   * `lt` rather than `lte`: an authenticator that legitimately reports the same
   * counter twice (many report a constant zero) has nothing to update, and treating
   * that as a write would churn `lastUsedAt` on every assertion for no reason. The
   * caller still logs the non-advance — see `verifyAuthentication`.
   */
  async touchPasskey(id: string, signCount: bigint, userId: string): Promise<void> {
    await this.prisma.passkey.updateMany({
      where: { id, userId, deletedAt: null, signCount: { lt: signCount } },
      data: { signCount, lastUsedAt: new Date() },
    });
  }

  async softDeletePasskey(id: string, userId: string): Promise<boolean> {
    const removed = await this.prisma.passkey.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return removed.count === 1;
  }

  /**
   * Retire every live passkey on the account, returning how many were retired.
   *
   * Separate from `softDeletePasskey` rather than a loop over it, because disabling
   * biometrics is one decision about the account and not N decisions about
   * credentials: a loop would leave the account half-disabled if it failed partway,
   * and the count a caller needs is "was anything actually on" rather than "did this
   * particular row exist".
   *
   * Returns a count, not a boolean, precisely because zero is not an error here —
   * `softDeletePasskey` answers "did the id you named exist", which is a question
   * about a caller-supplied id and must refuse when the answer is no. This answers
   * "how many were live", and a caller disabling an already-disabled setting has
   * asked for a state that is now true.
   */
  async softDeleteAllPasskeys(
    userId: string,
    context: SecurityContext,
    plan: RestrictionPlan,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, userId);

      const removed = await tx.passkey.updateMany({
        where: { userId, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // Same commit as the removal — see `softDeleteAllTotpFactors`.
      await stampRestrictionsLocked(tx, context, plan);
      return removed.count;
    });
  }

  async renamePasskey(id: string, userId: string, label: string): Promise<boolean> {
    const renamed = await this.prisma.passkey.updateMany({
      where: { id, userId, deletedAt: null },
      data: { label },
    });
    return renamed.count === 1;
  }

  // ─── recovery codes ───────────────────────────────────────────────────────

  /** Live means unspent AND not superseded — see the note on `replaceRecoveryCodes`. */
  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.prisma.recoveryCode.count({
      where: { userId, usedAt: null, supersededAt: null },
    });
  }

  /**
   * Does this account hold a CURRENT generation at all?
   *
   * `supersededAt: null` matters here rather than being tidiness: this is the gate on
   * whether enrollment mints a visible set. Counting retired generations would mean a
   * user who regenerated and then removed every factor could never be issued a
   * visible set again, because history would keep answering "yes, codes exist".
   *
   * Spent-but-current rows still count, deliberately: an account that used nine of
   * ten codes has a set, and re-issuing silently would invalidate the tenth.
   */
  async hasAnyRecoveryCode(userId: string): Promise<boolean> {
    const found = await this.prisma.recoveryCode.findFirst({
      where: { userId, supersededAt: null },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * Spend a recovery code, or refuse.
   *
   * A conditional UPDATE on `usedAt: null` for the same reason `claimTotpStep` is a
   * CAS: two requests presenting one code must not both succeed. Matching on the
   * hash rather than reading it first also means the plaintext never has to be
   * compared in application code.
   */
  async spendRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const spent = await this.prisma.recoveryCode.updateMany({
      // `supersededAt: null` so a code from a retired generation cannot be spent. A
      // user who regenerates has been handed a new sheet; the old one must stop
      // working the moment it is replaced, which before this column it did by being
      // deleted outright.
      where: { userId, codeHash, usedAt: null, supersededAt: null },
      data: { usedAt: new Date() },
    });
    return spent.count === 1;
  }

  /**
   * Replace the whole set, retiring the previous generation rather than erasing it.
   *
   * ─── Why this stopped being a delete ───────────────────────────────────────
   *
   * It used to run `deleteMany({ where: { userId } })` — the only hard delete in any
   * dboperation in this repository — and the predicate was scoped to the USER, not to
   * unspent rows. So it took SPENT codes with it, and directly destroyed the audit
   * trail this table's own schema comment promises: "was one used the night of the
   * incident" was unanswerable, because regenerating a set erased the evidence. The
   * `replaceRecoveryCodes(userId, [])` call on last-factor removal wiped the entire
   * history in one statement.
   *
   * The old justification was that a superseded hash "answers no question anybody
   * asks". Two questions ask it: which generation a used code belonged to, and
   * whether a code was used at all before the set was replaced.
   *
   * `supersededAt` rather than reusing `usedAt`, because conflating them would make
   * every regenerated code look as though somebody had signed in with it — turning
   * the trail from absent into actively misleading.
   *
   * One transaction, so there is never a moment where an account has neither
   * generation live.
   */
  /**
   * ─── Why this one is NOT guarded by the security cooldown ─────────────────
   *
   * Every other mutation in this file takes the row lock. This one deliberately does
   * not, because it has two callers with opposite standing: `regenerateRecoveryCodes`,
   * which is a user-initiated security change and IS frozen — at the service layer, by
   * `RecentSecurityChangePolicy` — and `clearRecoveryCodesIfLastFactor`, which is the
   * TAIL of a disable that has already been authorised, running after the factors are
   * gone.
   *
   * A lock here would refuse the second one when an email change landed mid-disable,
   * leaving an account with no second factor still holding live recovery codes — a way
   * in that the user never asked for, which is the exact state
   * `clearRecoveryCodesIfLastFactor` exists to prevent. Freezing a cleanup step is not
   * the same as freezing a security change, and conflating them here would trade a
   * closed race for an open credential.
   */
  async replaceRecoveryCodes(userId: string, codeHashes: readonly string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.recoveryCode.updateMany({
        // Only the current generation. Already-superseded rows keep their original
        // timestamp — re-stamping them would rewrite when each generation retired.
        where: { userId, supersededAt: null },
        data: { supersededAt: new Date() },
      });
      await tx.recoveryCode.createMany({
        data: codeHashes.map((codeHash) => ({ id: uuidv7(), userId, codeHash })),
      });
    });
  }

  /** The whole history, newest generation last. Retired rows included — this is the
   *  audit read, and excluding them would defeat the point of keeping them. */
  async listRecoveryCodes(userId: string): Promise<RecoveryCode[]> {
    return this.prisma.recoveryCode.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  // ─── the in-flight sign-in ────────────────────────────────────────────────

  /**
   * States a flow can still be driven from. The complement of the terminal pair.
   *
   * Named once because four different statements need to agree on it, and a list
   * written out four times is a list that will eventually disagree with itself.
   */
  private static readonly LIVE_STATES = ['STARTED', 'OTP_SENT', 'FACTOR_REQUIRED'] as const;

  /**
   * Open a flow for a caller who has not identified themselves yet.
   *
   * Called by whichever real login operation comes first — `password` once the
   * password verifies, `otp-request`, or `oauth-start`. There is no user to
   * supersede against at this point — that is the whole point of the state, and
   * the reason `userId` is nullable — so unlike `promoteAttempt` below it retires
   * nothing.
   *
   * What bounds the rows it creates is each entry point's own rate limiter,
   * charged before this runs; there is no separate flow-creation limiter, because
   * there is no separate flow-creation request. See `LOGIN_FLOW` in
   * auth/limits.ts.
   */
  async createFlow(input: {
    tokenHash: string;
    ipClass: string;
    deviceFingerprint: string;
    userAgent: string | null;
    expiresAt: Date;
  }): Promise<LoginAttempt> {
    return this.prisma.loginAttempt.create({
      data: { id: uuidv7(), state: 'STARTED', ...input },
    });
  }

  /**
   * Attach a resolved account to a flow, and move it to its next state.
   *
   * The ONE place a `LoginAttempt` learns whose sign-in it is. Every later step
   * reads identity from the row rather than the request, so this is the single
   * write that has to be right for "a flow cannot be switched between users" to
   * hold.
   *
   * A compare-and-swap on `from`, for the same reason `advanceState` is one in the
   * admin service: two concurrent first-factor submissions must not both advance
   * one flow. `userId` is written only on the transition that resolves it, and
   * never overwritten afterwards — the `userId: null` term in the WHERE is what
   * makes a second, different account impossible to attach rather than merely
   * unlikely.
   *
   * Supersedes the account's OTHER live flows in the same transaction. Two live
   * sign-ins for one person is the ordinary consequence of a double-clicked button
   * or a second tab, and leaving both open would mean a handle from an abandoned
   * one still minting a session minutes later.
   */
  async promoteAttempt(input: {
    id: string;
    userId: string;
    from: LoginState;
    to: LoginState;
    identifierLower?: string | null;
    expiresAt?: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.loginAttempt.updateMany({
        where: {
          id: input.id,
          state: input.from,
          completedAt: null,
          // Either the flow has no owner yet, or it already has this one. A row
          // naming somebody else is not a row this call may touch.
          OR: [{ userId: null }, { userId: input.userId }],
        },
        data: {
          state: input.to,
          userId: input.userId,
          ...(input.identifierLower !== undefined
            ? { identifierLower: input.identifierLower }
            : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        },
      });
      if (count !== 1) return false;

      await tx.loginAttempt.updateMany({
        where: {
          userId: input.userId,
          id: { not: input.id },
          state: { in: [...TwoFactorDbOperation.LIVE_STATES] },
        },
        // The hash goes with the state. Leaving it behind would keep a spent value
        // in the unique partial index and, worse, keep it matchable if a later
        // query forgot to filter.
        data: { state: 'EXPIRED', tokenHash: null },
      });
      return true;
    });
  }

  /** Record the identifier a flow attempted, without resolving an account.
   *
   *  Used by the passwordless path when the address matched nothing: the response
   *  is identical to the one a real account gets, so the row has to advance the
   *  same way or the next step would give the difference away. */
  async markOtpSent(id: string, identifierLower: string): Promise<boolean> {
    const { count } = await this.prisma.loginAttempt.updateMany({
      where: { id, state: { in: ['STARTED', 'OTP_SENT'] }, completedAt: null },
      data: { state: 'OTP_SENT', identifierLower },
    });
    return count === 1;
  }

  /**
   * Resolve the `loginId` a client presented. Never by id — the id is not a secret
   * and the hash is what the client actually proves possession of.
   *
   * `completedAt: null` is part of the WHERE rather than checked afterwards, so a
   * spent handle resolves to nothing at all rather than to a row a caller might
   * then forget to validate. It used to be neither: the lookup matched on the hash
   * alone and leaned entirely on `assertAttemptLive` running afterwards, which is
   * one forgotten call away from being no check at all.
   */
  async findAttemptByTokenHash(tokenHash: string): Promise<LoginAttempt | null> {
    return this.prisma.loginAttempt.findFirst({ where: { tokenHash, completedAt: null } });
  }

  /**
   * Charge a wrong guess and return the new total.
   *
   * Incremented BEFORE the code is compared, so a wrong guess costs an attempt even
   * if the request is abandoned mid-flight and a caller cannot get unlimited
   * guesses by racing. Same discipline as `verifyChallengeCode`.
   */
  async chargeAttempt(id: string): Promise<number> {
    const attempt = await this.prisma.loginAttempt.update({
      where: { id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return attempt.attempts;
  }

  /**
   * Retire a flow without completing it.
   *
   * Widened past `FACTOR_REQUIRED` with the flow row: a handle found expired at
   * `STARTED` or `OTP_SENT` has to be retired too, or the row keeps its place in
   * the live-handle index and a retry gets a different answer than the first try.
   *
   * Nulls the hash for the same reason completion does — a retired handle that is
   * still matchable is a handle.
   */
  async expireAttempt(id: string): Promise<void> {
    await this.prisma.loginAttempt.updateMany({
      where: { id, state: { in: [...TwoFactorDbOperation.LIVE_STATES] } },
      data: { state: 'EXPIRED', tokenHash: null },
    });
  }

  /**
   * ═══ RETIRE EVERY LIVE FLOW BELONGING TO ONE USER ═══════════════════════════
   *
   * `expireAttempt` by user rather than by id, and the same write: `promoteAttempt`
   * already supersedes an account's other live flows with exactly this statement, so
   * this is that supersede without the "except this one" term.
   *
   * ─── What it is for ────────────────────────────────────────────────────────
   *
   * A password change revokes the account's sessions, and that used to be the whole
   * of "changing your password ends other activity". It was not, because a sign-in
   * half-way through is not a session yet: a flow that has proven the password and
   * been promoted to `FACTOR_REQUIRED` holds a `loginId` with the MFA ceremony's
   * budget on it, and nothing in the second half of that ceremony looks at the
   * password again. `MfaService.requireAttempt` asks only that the row is live,
   * `FACTOR_REQUIRED`, and presented from the same device and network class.
   *
   * So somebody who knew the old password could start a sign-in, wait for the owner
   * to change it in response to exactly that suspicion, and still complete the flow
   * from the handle they were already holding. The session sweep could not see it —
   * there was no session — and the password write could not either.
   *
   * ─── Why the state list is the definition of "live" ────────────────────────
   *
   * `LIVE_STATES` is the codebase's existing answer to "which rows can still be
   * driven", shared with `expireAttempt` and `promoteAttempt`. Using it here means
   * COMPLETED and EXPIRED rows are untouched by construction rather than by a
   * separate rule that could drift from theirs: a flow that already minted its
   * session keeps its `completedAt`, and one already retired is not retired twice.
   *
   * ─── Atomicity ─────────────────────────────────────────────────────────────
   *
   * One `updateMany`, so every live row for the user flips in a single atomic
   * statement — there is no instant in which some of an account's flows are retired
   * and others are not. `tokenHash` is nulled with the state for the reason
   * `promoteAttempt` gives: leaving the hash behind keeps a spent value in the
   * `ux_login_attempts_token_live` partial index and keeps it matchable if a finder
   * ever forgets to filter.
   *
   * Scoped by `userId` and nothing else, so no other account's sign-in is affected.
   *
   * Returns the number retired, for the caller's log. A count of zero is the ordinary
   * case — most password changes happen with no sign-in in flight.
   */
  async expireLiveAttemptsForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.loginAttempt.updateMany({
      where: { userId, state: { in: [...TwoFactorDbOperation.LIVE_STATES] } },
      data: { state: 'EXPIRED', tokenHash: null },
    });
    return count;
  }

  /**
   * Mark the sign-in complete, or refuse.
   *
   * The compare-and-swap that stops one `loginId` minting two sessions. The caller
   * treats `false` as a failed verification rather than a quiet no-op, because a
   * loser here presented a correct code that something else already spent.
   *
   * Nulling `tokenHash` in the SAME statement that sets `completedAt` is what makes
   * the handle single-use: there is no interval, however small, in which a
   * completed flow still has a matchable value. It previously did not, and the
   * handle survived completion in the column — unmatchable in practice only
   * because every finder happened to filter it out, which is a property of the
   * queries rather than of the data.
   */
  async completeAttempt(id: string): Promise<boolean> {
    const completed = await this.prisma.loginAttempt.updateMany({
      where: { id, state: 'FACTOR_REQUIRED', completedAt: null },
      data: { state: 'COMPLETED', completedAt: new Date(), tokenHash: null },
    });
    return completed.count === 1;
  }
}
