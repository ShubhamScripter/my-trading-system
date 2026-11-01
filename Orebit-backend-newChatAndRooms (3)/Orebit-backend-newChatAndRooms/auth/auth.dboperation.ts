/**
 * The module's persistence surface.
 *
 * README.md's convention gives each module a single `<name>.dboperation.ts` as
 * "the only layer touching Prisma". That rule is intact — it is just spread over
 * three files, one per aggregate, to stay inside the 500-line limit. Nothing
 * outside these files imports PrismaService.
 *
 *   persistence/registration.dboperation.ts  registrations (the state machine row)
 *   persistence/session.dboperation.ts       sessions (rotation generations)
 *   persistence/challenge.dboperation.ts     verification_challenges (post-account codes)
 *   persistence/blocklist.dboperation.ts     blocked_emails (the admin-managed email blocklist)
 *   persistence/retained-email.dboperation.ts retained_emails (addresses an email change released)
 *   persistence/username-reservation.dboperation.ts username_reservations (usernames a change released)
 *   persistence/user.dboperation.ts          users, credentials, oauth_links
 *
 * Split by aggregate rather than by caller, so a table has exactly one owner and
 * "where is this written" has one answer.
 *
 * Like auth.service.ts, this re-exports nothing: callers import from
 * `persistence/` directly, and the only thing that needs a single place to look
 * is the provider list below.
 */

/** Every dboperation provider, for auth.module.ts to register in one place. */
import { BlocklistDbOperation } from './persistence/blocklist.dboperation';
import { ChallengeDbOperation } from './persistence/challenge.dboperation';
import { RegistrationDbOperation } from './persistence/registration.dboperation';
import { SessionDbOperation } from './persistence/session.dboperation';
import { DeviceDbOperation } from './persistence/device.dboperation';
import { UserDbOperation } from './persistence/user.dboperation';
import { RateLimitPolicyDbOperation } from './persistence/rate-limit-policy.dboperation';
import { RetainedEmailDbOperation } from './persistence/retained-email.dboperation';
import { UsernameReservationDbOperation } from './persistence/username-reservation.dboperation';

export const AUTH_DB_OPERATIONS = [
  RegistrationDbOperation,
  SessionDbOperation,
  DeviceDbOperation,
  ChallengeDbOperation,
  BlocklistDbOperation,
  UserDbOperation,
  RateLimitPolicyDbOperation,
  RetainedEmailDbOperation,
  UsernameReservationDbOperation,
] as const;
