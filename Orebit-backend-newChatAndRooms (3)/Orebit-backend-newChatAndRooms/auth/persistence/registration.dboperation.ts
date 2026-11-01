import { Injectable } from '@nestjs/common';
import type { OauthProvider, Registration, RegistrationState } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';

/** Persistence for `registrations` — the pre-account state machine's row. */

export interface CreateRegistrationInput {
  readonly email: string;
  readonly emailLower: string;
  readonly ipAddress: string;
  readonly countrySuggested: string | null;
  readonly otpHash: string | null;
  readonly otpExpiresAt: Date | null;
  readonly expiresAt: Date;
  readonly continuationSecretHash: string;
  readonly state: RegistrationState;
  readonly emailVerified: boolean;
  readonly oauth: {
    readonly provider: OauthProvider;
    readonly subject: string;
    readonly emailVerified: boolean;
    readonly avatarUrl?: string | null;
  } | null;
}

@Injectable()
export class RegistrationDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateRegistrationInput): Promise<Registration> {
    return this.prisma.registration.create({
      data: {
        id: uuidv7(),
        email: input.email,
        emailLower: input.emailLower,
        ipAddress: input.ipAddress,
        countrySuggested: input.countrySuggested,
        state: input.state,
        otpHash: input.otpHash,
        otpExpiresAt: input.otpExpiresAt,
        otpSentCount: input.otpHash === null ? 0 : 1,
        lastOtpSentAt: input.otpHash === null ? null : new Date(),
        emailVerifiedAt: input.emailVerified ? new Date() : null,
        expiresAt: input.expiresAt,
        continuationSecretHash: input.continuationSecretHash,
        oauthProvider: input.oauth?.provider ?? null,
        oauthSubject: input.oauth?.subject ?? null,
        oauthEmailVerified: input.oauth?.emailVerified ?? false,
        oauthAvatarUrl: input.oauth?.avatarUrl ?? null,
      },
    });
  }

  async findById(id: string): Promise<Registration | null> {
    return this.prisma.registration.findFirst({ where: { id, deletedAt: null } });
  }

  /**
   * THE lookup for every step after `start`: resolve a continuation secret to its
   * registration.
   *
   * Matched on the stored hash, and scoped to live rows only — `completedAt: null`
   * is what makes a spent secret unusable, so replaying the cookie from a finished
   * signup finds nothing rather than re-entering a completed flow. Backed by
   * `ix_registrations_continuation`.
   */
  async findByContinuationHash(hash: string): Promise<Registration | null> {
    return this.prisma.registration.findFirst({
      where: {
        continuationSecretHash: hash,
        deletedAt: null,
        completedAt: null,
        state: { notIn: ['EXPIRED', 'COMPLETED'] },
      },
    });
  }

  /**
   * Retire every live attempt for an address.
   *
   * Called by `start`, because abandoning the flow means starting over — there is
   * no resumption, so a second `start` supersedes the first rather than returning
   * it. Two things follow from that, both wanted: a stale cookie from the earlier
   * attempt stops resolving, and one address can never accumulate live rows.
   *
   * A soft delete rather than a hard one — the row is history, and history is kept.
   * But the secrets on it are cleared, because a retired attempt must not leave a
   * usable credential or a password hash behind.
   */
  async supersedeLiveAttempts(emailLower: string): Promise<number> {
    const { count } = await this.prisma.registration.updateMany({
      where: { emailLower, deletedAt: null, completedAt: null },
      data: {
        state: 'EXPIRED',
        deletedAt: new Date(),
        continuationSecretHash: null,
        pendingPasswordHash: null,
        otpHash: null,
      },
    });
    return count;
  }

  /** Existing OAuth-initiated attempt for a provider identity, so a user who
   *  bounces off Google twice does not end up with two registrations. */
  async findResumableByOauth(
    provider: OauthProvider,
    subject: string,
  ): Promise<Registration | null> {
    return this.prisma.registration.findFirst({
      where: {
        oauthProvider: provider,
        oauthSubject: subject,
        deletedAt: null,
        completedAt: null,
        expiresAt: { gt: new Date() },
        state: { notIn: ['EXPIRED', 'COMPLETED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Re-issue the continuation secret for an existing row — used when an OAuth
   *  attempt is resumed and the caller needs a cookie it can actually present. */
  async setContinuationSecret(id: string, hash: string): Promise<Registration> {
    return this.prisma.registration.update({
      where: { id },
      data: { continuationSecretHash: hash },
    });
  }

  /**
   * Store a freshly sent code.
   *
   * `otpSentCount` is incremented by the database, and `otpAttempts` is reset —
   * a new code deserves a fresh set of guesses, but not a fresh send budget.
   */
  async recordOtpSent(id: string, otpHash: string, otpExpiresAt: Date): Promise<Registration> {
    return this.prisma.registration.update({
      where: { id },
      data: {
        otpHash,
        otpExpiresAt,
        otpAttempts: 0,
        otpSentCount: { increment: 1 },
        lastOtpSentAt: new Date(),
      },
    });
  }

  /**
   * Give back one send after the email failed to leave the building.
   *
   * `otpSentCount` is charged before the send, because it has to gate it. When
   * SMTP then refuses the message, the user has paid for something they did not
   * get — and with five sends per registration, a short outage can exhaust the
   * budget while they sit watching an empty inbox.
   *
   * `updateMany` with a `gt: 0` guard rather than a bare decrement: a double
   * refund must not drive the count negative and hand out unlimited sends.
   */
  async refundOtpSend(id: string): Promise<void> {
    await this.prisma.registration.updateMany({
      where: { id, otpSentCount: { gt: 0 } },
      data: { otpSentCount: { decrement: 1 } },
    });
  }

  /** Retire exactly the OTP this enqueue attempt created. The hash predicate keeps
   * a failed older enqueue from clearing a newer resend issued concurrently. */
  async invalidateOtp(id: string, otpHash: string): Promise<void> {
    await this.prisma.registration.updateMany({
      where: { id, otpHash },
      data: { otpHash: null, otpExpiresAt: null, otpAttempts: 0 },
    });
  }

  /** The answer to "trust this device?", re-sendable while the user toggles it. */
  async setTrustDevice(id: string, trustDevice: boolean): Promise<Registration> {
    return this.prisma.registration.update({ where: { id }, data: { trustDevice } });
  }

  /** Returns the new attempt count so the caller can compare it against the cap
   *  without a second read. */
  async incrementOtpAttempts(id: string): Promise<number> {
    const { otpAttempts } = await this.prisma.registration.update({
      where: { id },
      data: { otpAttempts: { increment: 1 } },
      select: { otpAttempts: true },
    });
    return otpAttempts;
  }

  /**
   * Mark the email verified and clear the code.
   *
   * Clearing `otpHash` is not tidiness — it is what makes verification single-use.
   * Leaving the hash behind would let the same code be replayed, and would keep a
   * live credential in a row that no longer needs one.
   *
   * `nextState` is the caller's, because where verification lands depends on
   * whether the attempt still owes a credential decision: a direct signup does and
   * stops at `OTP_VERIFIED`, an OAuth-initiated one does not and goes straight to
   * `CREDENTIALS_SET`. Both are states this row is allowed to be in; neither
   * bypasses a guard.
   */
  async markEmailVerified(
    id: string,
    nextState: 'OTP_VERIFIED' | 'CREDENTIALS_SET' = 'OTP_VERIFIED',
  ): Promise<Registration> {
    return this.prisma.registration.update({
      where: { id },
      data: {
        state: nextState,
        emailVerifiedAt: new Date(),
        otpHash: null,
        otpExpiresAt: null,
        otpAttempts: 0,
      },
    });
  }

  async setReferralCode(id: string, code: string | null): Promise<Registration> {
    return this.prisma.registration.update({
      where: { id },
      data: { referralCodeEntered: code },
    });
  }

  /** Records the password decision without creating a User or Credential row. */
  async setCredentials(id: string, pendingPasswordHash: string | null): Promise<Registration> {
    return this.prisma.registration.update({
      where: { id },
      data: {
        pendingPasswordHash,
        passwordSet: pendingPasswordHash !== null,
        state: 'CREDENTIALS_SET',
      },
    });
  }

  // REMOVED: `complete(id, country)`. It closed the registration and nulled the
  // continuation hash, and it had ZERO call sites — the country step creates the
  // account and completes the row in one transaction, so the real completion is
  // the `tx.registration.update` inside `UserDbOperation.createAccount`.
  //
  // Deleted rather than wired up, because two ways to close a registration is how
  // they drift: this one was the one that looked correct while the one that
  // actually ran was the one missing `continuationSecretHash: null`. That null is
  // now on the live path, where it belongs — a second implementation would only
  // give the next reader something to call instead of it, outside the transaction
  // that creates the user.

  /**
   * Expire an abandoned attempt, clearing everything on it that is a credential.
   *
   * `pendingPasswordHash` is the one that matters: it is an argon2 hash of a real
   * user's password, parked on this row between the `credentials` and `country`
   * steps. An expired registration has no use for it, and leaving it behind would
   * accumulate password material on dead rows indefinitely.
   */
  async markExpired(id: string): Promise<Registration> {
    return this.prisma.registration.update({
      where: { id },
      data: {
        state: 'EXPIRED',
        continuationSecretHash: null,
        pendingPasswordHash: null,
        otpHash: null,
      },
    });
  }
}
