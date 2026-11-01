import { RECOVERY_CODES } from '../../auth/auth.constants';
import { policy } from '../../auth/limits';
import { pepperedHash } from '../../auth/auth.utility';
import { randomBase32 } from '../utils/public.utils';

/**
 * Printable single-use codes, the way back in when the authenticator is gone.
 *
 * ─── Why this exists here and not in the admin service ──────────────────────
 *
 * The admin service has no equivalent and is right not to: an admin enrols two
 * kinds of factor, so either recovers the other, and there is an IT team behind
 * them. A consumer typically enrols one authenticator on one phone. Losing it
 * without these means losing the account outright — email OTP is only the FIRST
 * factor, so it cannot let anyone back past the second.
 *
 * ─── What a recovery code is allowed to do ──────────────────────────────────
 *
 * Satisfy a sign-in, and nothing else. It must never mint an elevation ticket, or
 * a single sheet of paper would authorise removing the real factor — which makes
 * "I lost my phone" and "I stole your printout" the same event. That rule is
 * enforced at the call site in 2fa.service.ts, not here; this file only knows how
 * to make and check the strings.
 */

/**
 * Crockford base32, deliberately NOT the RFC 4648 alphabet `totp.ts` uses.
 *
 * These are read off a screen or a printout and typed back in, sometimes months
 * later, so the alphabet that omits I, L, O and U is the right one — those are
 * exactly the characters a person mistakes for 1 and 0. The TOTP secret has the
 * opposite requirement (an app parses it, and the app expects RFC 4648), which is
 * why the two live in different files with the reason written down in both.
 *
 * Formatted in two groups with a hyphen — `4X7K9-M2QRT` — purely so it is legible.
 * `normaliseRecoveryCode` strips it back out, so the stored hash never sees it.
 */
export function generateRecoveryCode(): string {
  const raw = randomBase32(RECOVERY_CODES.LENGTH);
  const half = Math.floor(RECOVERY_CODES.LENGTH / 2);
  return `${raw.slice(0, half)}-${raw.slice(half)}`;
}

/** A full set, for a user who has just confirmed their first factor. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: policy().MFA.RECOVERY_CODE_COUNT }, generateRecoveryCode);
}

/**
 * What a typed code becomes before it is hashed.
 *
 * Uppercased, and every character outside the Crockford alphabet dropped — which
 * covers the hyphen we added, spaces pasted in from a password manager, and the
 * stray whitespace a mobile keyboard appends. Being generous here costs nothing:
 * the code is compared against a hash of the same normalisation, so a value that
 * normalises to something wrong simply fails to match.
 */
export function normaliseRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '');
}

/** The stored form. Domain `'recovery'` so a value lifted from this table cannot
 *  verify against an OTP row — see `HashDomain` in auth/auth.utility.ts. */
export function hashRecoveryCode(code: string): string {
  return pepperedHash(normaliseRecoveryCode(code), 'recovery');
}
