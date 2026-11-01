import { Injectable, Logger } from '@nestjs/common';
import type { OauthProvider, Registration } from '@prisma/client';
import { isUniqueViolation, violatedIndex } from '../../db/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { MailService } from '../../src/mail/mail.service';
import { USERNAME } from '../auth.constants';
import type { PublicUser } from '../auth.types';
import {
  emailLocalPart,
  generatePublicCode,
  generateReferralCode,
  generateUsernameCandidates,
  normaliseCode,
  toPublicUser,
} from '../auth.utility';
import type { UpdateMyProfileRequest } from '../dto/common.dto';
import { UserDbOperation, type UserWithCredential } from '../persistence/user.dboperation';
import { UsernameTakenError } from '../persistence/username-reservation.dboperation';

/**
 * Account creation — the one place a `User` row comes into existence.
 *
 * Its whole job is allocating the three identifiers that must be unique
 * (username, public code, referral code) against a database that is the only
 * authority on whether they are.
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger('UserService');

  constructor(
    private readonly users: UserDbOperation,
    private readonly mail: MailService,
  ) {}

  /**
   * Create the account for a verified registration.
   *
   * ─── Why this is a retry loop and not a check-then-insert ────────────────
   *
   * The obvious implementation asks "is this username taken?" and inserts if not.
   * That is wrong under concurrency: two signups deriving the same stem from
   * `alice@a.com` and `alice@b.com` both read "available" and one insert fails —
   * except now the failure surfaces as a 500 rather than as a second attempt.
   *
   * So it inserts and catches instead. The partial unique index is the authority,
   * and a violation is an expected outcome routed back into the loop with fresh
   * random suffixes. Every candidate after the first carries new random digits, so
   * the collision probability compounds down to nothing across attempts.
   *
   * All three identifiers are regenerated per attempt, because the violation does
   * not say which one collided — and re-rolling a public code that did not collide
   * costs nothing.
   */
  async createFromRegistration(input: {
    registration: Registration;
    passwordHash: string | null;
    country: string;
    countryIp: string | null;
    oauthName: string | null;
  }): Promise<UserWithCredential> {
    const { registration } = input;

    // The username seed: the provider's display name on the social path, the email
    // local-part otherwise. The provider's name is preferred because it is what
    // the user recognises as their own — `john.smith` reads better than the
    // `jsmith1987` their email happens to use.
    const seed = input.oauthName ?? emailLocalPart(registration.email);
    const candidates = generateUsernameCandidates(seed, USERNAME.MAX_ALLOCATION_ATTEMPTS);

    const referrer = await this.resolveReferrer(registration.referralCodeEntered);

    for (const [attempt, username] of candidates.entries()) {
      const publicCode = generatePublicCode();
      try {
        const created = await this.users.createAccount({
          email: registration.email,
          emailLower: registration.emailLower,
          // A registration only reaches this step with a verified address — either
          // our OTP or a provider assertion. Both are recorded the same way.
          emailVerified: registration.emailVerifiedAt !== null,
          username,
          publicCode,
          publicCodeKey: normaliseCode(publicCode),
          referralCode: generateReferralCode(),
          referredByCode: registration.referralCodeEntered,
          referredByUserId: referrer?.id ?? null,
          country: input.country,
          countryIp: input.countryIp,
          avatarUrl: registration.oauthAvatarUrl ?? null,
          passwordHash: input.passwordHash,
          oauth:
            registration.oauthProvider !== null && registration.oauthSubject !== null
              ? {
                  provider: registration.oauthProvider,
                  subject: registration.oauthSubject,
                  emailAtLink: registration.email,
                  emailVerifiedByProvider: registration.oauthEmailVerified,
                  avatarUrl: registration.oauthAvatarUrl ?? null,
                }
              : null,
          registrationId: registration.id,
        });

        // No longer awaited, and no longer on the response path: `sendWelcome`
        // hands the message to the transport and returns. Signup used to block on
        // the SMTP conversation, which was survivable only because MailService
        // swallows its own failures — a dead relay cost every new account up to
        // twenty seconds. Nothing is charged for a welcome email, so there is no
        // undo to pass.
        this.mail.sendWelcome(created.user.email, created.user.username, created.user.publicCode);

        return created;
      } catch (err) {
        // A username somebody released recently and may still want back. Not a
        // constraint violation — no live account holds the name, so the unique index
        // is satisfied and only `username_reservations` knows better — but it means
        // exactly what one means here: this candidate is spoken for, take the next.
        //
        // Checked before `isUniqueViolation` because it is not one, and folding it in
        // there would make a reservation look like an index the caller could name.
        if (err instanceof UsernameTakenError) {
          this.logger.warn(
            { attempt: attempt + 1, username },
            'candidate username is reserved; retrying',
          );
          continue;
        }

        if (!isUniqueViolation(err)) throw err;

        // The provider link. Retrying is pointless for the same reason as the
        // email — a fresh username does not free up `(provider, subject)` — but
        // unlike the email it is not discoverable with a second query, so it has
        // to be read off the error. Without this, all six candidates fail
        // identically and the caller is told username generation broke, which
        // sends whoever debugs it looking in the wrong place entirely.
        if (violatedIndex(err, 'ix_oauth_links_provider_subject_active')) {
          throw new ProblemException({ type: ERR.OAUTH_ALREADY_LINKED });
        }

        // The email index. Retrying cannot help — a different username will not
        // make the address free — and it means someone registered this address
        // between the start of this registration and now.
        if (await this.users.emailExists(registration.emailLower)) {
          throw new ProblemException({ type: ERR.EMAIL_ALREADY_REGISTERED });
        }

        this.logger.warn(
          { attempt: attempt + 1, username },
          'identifier collision during account creation; retrying',
        );
      }
    }

    // Every candidate collided. With random 4-digit suffixes this is not a
    // plausible outcome, so reaching here means something is structurally wrong
    // (an index in an unexpected state, a bug in candidate generation) and it
    // should be loud rather than silently retried forever.
    this.logger.error(
      { registrationId: registration.id, attempts: candidates.length },
      'exhausted username candidates',
    );
    throw new ProblemException({ type: ERR.USERNAME_GENERATION_FAILED });
  }

  /**
   * Resolve a referral code to its owner.
   *
   * A miss is not an error. The product's rule is that an unmatched code at final
   * submit is accepted and ignored, because failing a signup over a mistyped
   * referral code costs a user for no benefit — the code is a nice-to-have
   * attribution, not a requirement. `User.referredByCode` keeps the raw string
   * either way, so a code that turns out to be valid later is still on record.
   */
  private async resolveReferrer(code: string | null): Promise<{ id: string } | null> {
    if (code === null) return null;
    const referrer = await this.users.findByReferralCode(normaliseCode(code));
    return referrer === null ? null : { id: referrer.id };
  }

  /** Does a referral code match a live account? Used by the explicit check step. */
  async lookupReferrer(code: string): Promise<{ username: string } | null> {
    const referrer = await this.users.findByReferralCode(normaliseCode(code));
    return referrer === null ? null : { username: referrer.username };
  }

  /** Whether an OAuth provider identity is already linked to an account. */
  async findLinkedAccount(provider: OauthProvider, subject: string) {
    return this.users.findOauthLink(provider, subject);
  }

  /** Whether a live account already holds this address. Takes the already
   *  normalised form — the DTO lowercases, and this module owns no second
   *  opinion on what "the same address" means. */
  async emailExists(emailLower: string): Promise<boolean> {
    return this.users.emailExists(emailLower);
  }

  /** The authenticated user's safe profile representation. */
  async getCurrentUser(userId: string): Promise<PublicUser> {
    const found = await this.requireCurrentUser(userId);
    return toPublicUser(found.user, found.credential !== null);
  }

  /** Update only the profile fields explicitly exposed by the user API. */
  async updateMyProfile(userId: string, input: UpdateMyProfileRequest): Promise<PublicUser> {
    const found = await this.requireCurrentUser(userId);
    const user = await this.users.setCountry(userId, input.country);
    return toPublicUser(user, found.credential !== null);
  }

  private async requireCurrentUser(userId: string): Promise<UserWithCredential> {
    const found = await this.users.findWithCredential(userId);
    if (found === null) {
      // A token can outlive a soft-deleted account. Do not turn that stale token
      // into a 500 or disclose whether the account existed.
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }
    return found;
  }
}
