import { AdminDbOperation } from './persistence/admin.dboperation';
import { AttemptDbOperation } from './persistence/attempt.dboperation';
import { AuthEventDbOperation } from './persistence/authevent.dboperation';
import { ChallengeDbOperation } from './persistence/challenge.dboperation';
import { MfaDbOperation } from './persistence/mfa.dboperation';
import { SessionDbOperation } from './persistence/session.dboperation';

/**
 * The persistence barrel for `auth/`.
 *
 * These six, plus `TwoFactorDbOperation` in src/2fa/, `AdminsDbOperation` in
 * src/admins/ and `OtpQueueDbOperation` in src/mail/, are the ONLY classes in the
 * service permitted to inject `PrismaService`. That restriction is review
 * discipline rather than something the framework enforces, and these barrels are
 * what make it auditable: a new file injecting Prisma would have to either appear
 * in one of them or be missing from its module, and both are visible.
 */
export const AUTH_DB_OPERATIONS = [
  AdminDbOperation,
  AttemptDbOperation,
  AuthEventDbOperation,
  ChallengeDbOperation,
  MfaDbOperation,
  SessionDbOperation,
] as const;

export { AdminDbOperation, type AdminWithCredential } from './persistence/admin.dboperation';
export { AttemptDbOperation } from './persistence/attempt.dboperation';
export {
  AUTH_EVENT,
  AuthEventDbOperation,
  type AuthEventType,
  type AuthFailureStage,
} from './persistence/authevent.dboperation';
export { ChallengeDbOperation } from './persistence/challenge.dboperation';
export { MfaDbOperation } from './persistence/mfa.dboperation';
export {
  SessionDbOperation,
  SessionRotationConflict,
} from './persistence/session.dboperation';
