import type { ValidationIssue } from '../../http';
import {
  EMAIL_CHANGE_METHODS,
  EMAIL_CHANGE_PROOF_FIELDS,
  EMAIL_CHANGE_UNAVAILABLE,
  PROOF_FIELD_BY_METHOD,
  isEmailChangeMethod,
  isEmailProofTarget,
  isRecoveryIntent,
  type EmailChangeAccount,
  type EmailChangeGrant,
  type EmailChangeMethod,
  type EmailProofTarget,
  type EmailRecoveryGrant,
} from './email.types';

/**
 * Pure helpers for the email-change surface.
 *
 * Functions rather than a service, for `settings.utility.ts`'s reason: the interesting
 * behaviour here is what these REFUSE, and a table-driven test of every combination
 * should not have to stand up a DI container to run. Nothing here does I/O, reads the
 * clock, or touches config.
 */

// ─── masking ────────────────────────────────────────────────────────────────

/**
 * `ada.lovelace@example.test` → `a***e@example.test`.
 *
 * ─── What this is for, and what it is not ──────────────────────────────────
 *
 * It is for a screen and for a notification: enough for a reader to recognise an address
 * they own, not enough for a shoulder-surfer, a screenshot or a support transcript to
 * carry one. The domain stays whole because that is what makes it recognisable at all —
 * masking `@example.test` would leave a string nobody can identify.
 *
 * It is NOT a security control. Anyone who can call `GET /auth/me` sees their own
 * address in full, and the masking here does not pretend otherwise. Where it earns its
 * keep is the email-changed notification, which goes to an address the account no longer
 * controls: printing the account's new address there in full would hand a stranger the
 * exact identifier they need to keep attacking it.
 *
 * ─── Why short local parts are masked harder, not softer ───────────────────
 *
 * `ab@x.com` masked as `a***b` would reveal both characters there are. Anything under
 * four characters therefore keeps no plaintext at all. The rule is deliberately
 * conservative at the short end, because that is where a mask leaks proportionally most.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    // Not an address this function can reason about. Mask it wholesale rather than
    // returning it — a caller has already made a mistake, and leaking the value is the
    // worse of the two ways to react.
    return '***';
  }

  const local = email.slice(0, at);
  const domain = email.slice(at);

  if (local.length < 4) return `***${domain}`;
  return `${local[0] as string}***${local[local.length - 1] as string}${domain}`;
}

// ─── which method is this request naming ────────────────────────────────────

export type MethodResolution =
  | { readonly ok: true; readonly method: EmailChangeMethod }
  | { readonly ok: false; readonly problems: readonly ValidationIssue[] };

/** The declared method plus whatever proofs came with it. Every proof is `unknown`
 *  because this decides which fields are PRESENT, never what they contain. */
interface DeclaredProof {
  readonly method: string;
  readonly totpCode?: unknown;
  readonly passkey?: unknown;
  readonly kyc?: unknown;
  readonly password?: unknown;
}

/**
 * Does this request carry exactly the proof its declared method names?
 *
 * ─── Why ambiguity is refused rather than resolved ──────────────────────────
 *
 * The reflex implementation tries each proof and accepts whichever verifies. That turns
 * five separate tiers into one OR, so the WEAKEST one present is the only one that
 * matters — a caller sending a password alongside a passkey assertion would be
 * authorised by whichever branch happened to run first. Since the tiers here are
 * explicitly ordered by strength, that is a downgrade attack with a friendly interface.
 *
 * So the client declares one tier, the schema refuses any proof that tier does not take,
 * and the service runs that tier and no other.
 *
 * ─── Why `none` takes no proof and says so ──────────────────────────────────
 *
 * The `none` tier is reachable only for an account with no factor, no KYC and no
 * password, and a request naming it must carry nothing. Accepting a stray `password`
 * field there would be the one case where the resolver's answer and the service's
 * behaviour could disagree — the service would ignore it, and the caller would believe
 * it had been checked.
 *
 * ─── Why this runs in the DTO and again in the service ──────────────────────
 *
 * In the DTO so a client gets a validation error naming the field. In the service
 * because the service is also reachable from tests and from any future caller, and a
 * policy that only holds when the HTTP layer is in front of it is not the policy — the
 * argument `resolveDisablePath` documents next door.
 */
export function resolveEmailChangeProof(input: DeclaredProof): MethodResolution {
  const { method } = input;

  if (!isEmailChangeMethod(method)) {
    return {
      ok: false,
      problems: [
        { path: 'method', message: `Must be one of: ${EMAIL_CHANGE_METHODS.join(', ')}.` },
      ],
    };
  }

  const present = EMAIL_CHANGE_PROOF_FIELDS.filter((field) => input[field] !== undefined);

  if (method === 'none') {
    if (present.length > 0) {
      return {
        ok: false,
        problems: present.map((field) => ({
          path: field,
          message:
            'Not permitted for the "none" method, which takes no proof. ' +
            'Declare the method this account actually uses.',
        })),
      };
    }
    return { ok: true, method };
  }

  const expected = PROOF_FIELD_BY_METHOD[method];

  const extras = present.filter((field) => field !== expected);
  if (extras.length > 0) {
    return {
      ok: false,
      problems: extras.map((field) => ({
        path: field,
        message:
          `Not permitted for the "${method}" method, which is proved with "${expected}". ` +
          'Send exactly one proof, matching the method you declared.',
      })),
    };
  }

  if (!present.includes(expected)) {
    return {
      ok: false,
      problems: [{ path: expected, message: `Required for the "${method}" method.` }],
    };
  }

  return { ok: true, method };
}

// ─── availability ───────────────────────────────────────────────────────────

/**
 * Which tiers this account can use, strongest first.
 *
 * ─── Why this returns a list and then truncates it ──────────────────────────
 *
 * The product says "2FA OR passkey OR KYC, falling back to password, falling back to
 * nothing", and the fallback has to be a fallback rather than a menu. So the strong
 * tiers are all offered together — a user with both an authenticator and a passkey
 * should be able to reach for whichever is to hand — but the moment any of them exists,
 * `password` and `none` are withheld.
 *
 * Getting that wrong in the permissive direction is the whole risk: offering the
 * password alongside a passkey would let every client take the easy branch, and the
 * strong tiers would be documentation.
 *
 * Pure and synchronous given the snapshot, which is what lets the status render and the
 * pre-consumption check share it — so a tier the screen offered can never be one the
 * verification refuses.
 */
export function methodsFor(account: EmailChangeAccount): readonly EmailChangeMethod[] {
  const strong = (['authenticator', 'passkey', 'kyc'] as const).filter((method) =>
    methodAvailable(method, account),
  );
  if (strong.length > 0) return strong;

  if (account.hasPassword) return ['password'];
  return ['none'];
}

/** Whether one tier is usable on this account. The single condition per tier. */
export function methodAvailable(
  method: EmailChangeMethod,
  account: EmailChangeAccount,
): boolean {
  switch (method) {
    case 'authenticator':
      return account.totpEnrolled;
    case 'passkey':
      return account.passkeyEnabled;
    case 'kyc':
      return account.kycVerified;
    // Both fallbacks are available only when nothing stronger is — asked directly, they
    // answer for themselves, and `assertMethodAllowed` is what enforces the ordering.
    case 'password':
      return account.hasPassword;
    case 'none':
      return true;
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

/** Why a tier is closed, for the one caller that has to say so. */
export function methodUnavailableReason(method: EmailChangeMethod): string {
  switch (method) {
    case 'authenticator':
      return EMAIL_CHANGE_UNAVAILABLE.NO_TOTP;
    case 'passkey':
      return EMAIL_CHANGE_UNAVAILABLE.NO_PASSKEY;
    case 'kyc':
      return EMAIL_CHANGE_UNAVAILABLE.NO_KYC;
    case 'password':
      return EMAIL_CHANGE_UNAVAILABLE.NO_PASSWORD;
    case 'none':
      // Unreachable: `none` is available to everyone, so nothing ever needs its reason.
      return EMAIL_CHANGE_UNAVAILABLE.NO_PASSWORD;
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

/**
 * Is the declared tier one this account may actually use RIGHT NOW?
 *
 * Two questions, not one, and the second is the one that matters. A tier must be
 * available on the account — and it must also be among the tiers `methodsFor` would
 * offer, which is what stops a client naming `password` on an account that has a
 * passkey. Checking only the first would make the fallback ordering advisory.
 */
export function methodAllowed(
  method: EmailChangeMethod,
  account: EmailChangeAccount,
): boolean {
  return methodAvailable(method, account) && methodsFor(account).includes(method);
}

// ─── the grants, out to Redis and back ──────────────────────────────────────

export function serialiseGrant(grant: EmailChangeGrant | EmailRecoveryGrant): string {
  return JSON.stringify(grant);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Read an in-flight change back, or `null` for anything unreadable.
 *
 * Total, deliberately: every failure mode — not JSON, missing field, a method or target
 * this build does not know — collapses to `null`, which the caller already treats as "no
 * such change". A parse that threw would turn a format change, or a record written by a
 * previous deploy, into a 500 on a path whose honest answer is "start again". The
 * challenge lives thirty minutes, so a format change costs at most half an hour of one
 * deploy.
 */
export function parseChangeGrant(raw: string | null): EmailChangeGrant | null {
  const parsed = parseObject(raw);
  if (parsed === null) return null;

  const challengeId = readString(parsed, 'challengeId');
  const userId = readString(parsed, 'userId');
  const familyId = readString(parsed, 'familyId');
  const newEmail = readString(parsed, 'newEmail');
  const newEmailLower = readString(parsed, 'newEmailLower');
  const method = readString(parsed, 'method');

  if (challengeId === null || userId === null || familyId === null) return null;
  if (newEmail === null || newEmailLower === null) return null;
  if (method === null || !isEmailChangeMethod(method)) return null;

  const rawTargets = parsed.requiredTargets;
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) return null;
  const requiredTargets: EmailProofTarget[] = [];
  for (const target of rawTargets) {
    if (typeof target !== 'string' || !isEmailProofTarget(target)) return null;
    requiredTargets.push(target);
  }

  const retained = parsed.retainedEmailLower;
  if (retained !== null && typeof retained !== 'string') return null;

  return {
    challengeId,
    userId,
    familyId,
    newEmail,
    newEmailLower,
    method,
    requiredTargets,
    retainedEmailLower: retained === null || retained === '' ? null : retained,
    skippedRetained: parsed.skippedRetained === true,
  };
}

/** Read an in-flight recovery back, or `null`. Total, for `parseChangeGrant`'s reason. */
export function parseRecoveryGrant(raw: string | null): EmailRecoveryGrant | null {
  const parsed = parseObject(raw);
  if (parsed === null) return null;

  const challengeId = readString(parsed, 'challengeId');
  const retainedEmailId = readString(parsed, 'retainedEmailId');
  const userId = readString(parsed, 'userId');
  const intent = readString(parsed, 'intent');
  const targetEmail = readString(parsed, 'targetEmail');
  const targetEmailLower = readString(parsed, 'targetEmailLower');

  if (challengeId === null || retainedEmailId === null || userId === null) return null;
  if (intent === null || !isRecoveryIntent(intent)) return null;
  if (targetEmail === null || targetEmailLower === null) return null;

  return {
    challengeId,
    retainedEmailId,
    userId,
    intent,
    targetEmail,
    targetEmailLower,
    reportedCompromise: parsed.reportedCompromise === true,
  };
}
