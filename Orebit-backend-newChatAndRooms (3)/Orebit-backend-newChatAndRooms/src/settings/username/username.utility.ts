import { randomBase32 } from '../../utils/public.utils';
import { USERNAME } from '../../../auth/auth.constants';
import {
  RESERVED_USERNAMES,
  type UsernameAssessment,
  type UsernameIssue,
  type UsernameLengthBand,
} from './username.types';

/**
 * Pure username rules. Nothing in this file does I/O, reads the clock, or touches
 * config — `payment-pin.utility.ts`'s rule, and for the same reason: every one of these
 * is run at least twice, once where a refusal is cheap and once where it is
 * authoritative, and a function with a dependency cannot be run in both places.
 */

/** The charset, as one source. Published to clients in `UsernameRules.pattern` so the
 *  field's client-side hint and the server's refusal cannot describe different rules. */
export const USERNAME_PATTERN = '^[a-z0-9_]+$';

const USERNAME_REGEX = /^[a-z0-9_]+$/;

/**
 * ═══ THE ONE NORMALISATION ══════════════════════════════════════════════════
 *
 * Every layer calls this and no layer does anything else: availability, suggestions,
 * the database lookup, the database write, the reservation lookup, the Bloom lookup and
 * the Bloom update. A second implementation anywhere is a bug, because two layers that
 * disagree about what `Shubh` normalises to will disagree about whether it is taken.
 *
 * ─── NFKC, not NFKD ─────────────────────────────────────────────────────────
 *
 * `sanitiseUsernameSeed` in auth/auth.utility.ts uses NFKD and strips the combining
 * marks, which is right for what it does: it turns a person's NAME into a plausible
 * username, so `Ámélie` should become `amelie` rather than being rejected.
 *
 * This is the opposite job. The input is a username the user has chosen, and silently
 * rewriting it would mean someone types `café` and is told a completely different name
 * is taken. So this composes rather than decomposes, and anything still outside the
 * charset is REFUSED by `assessUsername` rather than transformed. The user finds out
 * what is wrong instead of receiving a name they did not ask for.
 *
 * NFKC also does the compatibility folding that closes the spoofing hole: the fullwidth
 * `ａｄｍｉｎ` and the ligature `ﬁ` normalise onto their ASCII forms here, so they cannot
 * be used to slip a visually identical username past the reserved list or past an
 * account that already exists. What NFKC does not fold — Cyrillic `а`, Greek `ο` — the
 * charset check refuses outright, which is the only reliable defence against homoglyphs
 * and the reason this product does not accept Unicode usernames at all.
 *
 * Trim before lowercase is irrelevant to the result and deliberate anyway: it keeps the
 * order identical to `emailSchema` and `normaliseCode`, so all three read the same.
 */
export function normaliseUsername(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/**
 * Does this normalised username satisfy the rules for a caller with this length band?
 *
 * Returns a verdict instead of throwing, so the same call can render a 200 body on the
 * availability endpoint and a 400 on the mutation — the `assessPin` contract, one
 * directory over.
 *
 * Reports EVERY problem rather than the first. A user who typed `Ab!` has three things
 * to fix and finding them one request at a time is the difference between a form that
 * works and one people abandon.
 *
 * The band is a parameter and never a constant, because the minimum depends on an
 * entitlement this file cannot see and must not guess. `UsernameService` resolves it
 * from `PremiumStatusPort` and passes it in.
 */
export function assessUsername(
  normalised: string,
  band: UsernameLengthBand,
): UsernameAssessment {
  const issues: UsernameIssue[] = [];

  if (!USERNAME_REGEX.test(normalised)) {
    issues.push({
      code: 'charset',
      message: 'Use only lowercase letters, digits and underscores.',
    });
  }

  if (normalised.length < band.minLength) {
    issues.push({
      code: 'too_short',
      message: `Must be at least ${band.minLength} characters.`,
    });
  }

  if (normalised.length > band.maxLength) {
    issues.push({
      code: 'too_long',
      message: `Must be at most ${band.maxLength} characters.`,
    });
  }

  // A leading or trailing underscore is invisible at the end of a rendered name, so
  // `shubh_` and `shubh` are the same string to a reader and different strings to the
  // unique index — which is the whole shape of an impersonation. Runs in the middle are
  // refused for the same reason: `a__b` and `a_b` are not distinguishable in most
  // proportional fonts.
  if (normalised.startsWith('_') || normalised.endsWith('_')) {
    issues.push({
      code: 'edge_underscore',
      message: 'Cannot start or end with an underscore.',
    });
  } else if (normalised.includes('__')) {
    issues.push({
      code: 'edge_underscore',
      message: 'Cannot contain two underscores in a row.',
    });
  }

  if (RESERVED_USERNAMES.has(normalised)) {
    issues.push({ code: 'reserved', message: 'That username is not available.' });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** The band a caller is entitled to. The only place the tier becomes a number. */
export function lengthBandFor(premium: boolean): UsernameLengthBand {
  return {
    minLength: premium ? USERNAME.PREMIUM_MIN_LENGTH : USERNAME.DEFAULT_MIN_LENGTH,
    maxLength: USERNAME.MAX_LENGTH,
  };
}

/**
 * Was this reservation the long, identity-protecting one?
 *
 * Derived from the row's own two timestamps rather than stored in a column, and the
 * comparison is exact rather than approximate: a churn release is created with exactly
 * `RELEASE_SECONDS` of life and a protected one with thirty days, so any row whose span
 * EXCEEDS the release window is a protected one. There is no value in between for the
 * test to be ambiguous about.
 *
 * ─── Why this distinction is worth making at all ───────────────────────────
 *
 * It decides whether reclaiming your own previous username is free once your allowance
 * is spent, and both halves of that matter.
 *
 * It must be free for the protected one. That reservation exists so an account whose
 * username was taken during a compromise can get it back, and an owner who cannot pay
 * is precisely the person the protection is for. Charging there would sell people their
 * own identity back.
 *
 * It must NOT be free for the churn ones, and this is the sharper edge. Every hop of an
 * A -> B -> A -> B ping-pong lands on a name the account itself reserved moments ago,
 * so a blanket reclaim waiver would make an unlimited sequence of changes free. Waiving
 * only the protected reservation bounds it: the first hop back is free, the next hop is
 * an ordinary change and meets the allowance.
 */
export function isProtectedReservation(reservation: {
  createdAt: Date;
  expiresAt: Date;
}): boolean {
  const span = reservation.expiresAt.getTime() - reservation.createdAt.getTime();
  return span > USERNAME.RELEASE_SECONDS * 1000;
}

/**
 * Alternatives to offer when a username is unavailable.
 *
 * Returns MORE than are needed, in preference order, because the caller has to check
 * them against the database and will lose some — asking for exactly five and offering
 * whatever survives would routinely offer two.
 *
 * ─── The shapes, and why they are not all suffixes ─────────────────────────
 *
 * A column of `shubh_1`, `shubh_2`, `shubh_3` reads as "we could not think of
 * anything", and every one of them is equally likely to be taken already, because
 * whoever took `shubh` probably took those too. So the list mixes suffixed, prefixed
 * and padded forms: the prefixes (`itshubh`, `realshubh`) are the ones that actually
 * tend to be free, and they are the reason this is worth having as a function rather
 * than a loop over integers.
 *
 * Every candidate is normalised and length-clamped here, so a caller can hand any of
 * them straight back to `assessUsername` without special cases. A stem long enough to
 * overflow the maximum once a suffix is added is trimmed rather than dropped, so a
 * thirty-character username still produces suggestions.
 */
export function suggestionCandidates(
  normalisedStem: string,
  band: UsernameLengthBand,
  count: number,
): string[] {
  // Strip the decoration a previous suggestion may have added, so suggesting against
  // `shubh_21` proposes variants of `shubh` rather than of `shubh_21`.
  const stem = normalisedStem.replace(/[_0-9]+$/, '') || normalisedStem;

  const shapes = [
    (n: number) => `${stem}_${String(n).padStart(2, '0')}`,
    () => `its${stem}`,
    () => `real${stem}`,
    (n: number) => `${stem}${String(n).padStart(2, '0')}`,
    () => `${stem}_${randomBase32(4).toLowerCase()}`,
    () => `the${stem}`,
    (n: number) => `${stem}_${String(n)}`,
  ];

  const out: string[] = [];
  const seen = new Set<string>();

  for (let round = 0; out.length < count && round < 6; round += 1) {
    for (const shape of shapes) {
      if (out.length >= count) break;

      // Two digits of entropy per round, so repeated rounds do not re-propose the same
      // number. Not security-relevant — a suggestion is only a proposal, and every one
      // is checked against Postgres before it is offered.
      const candidate = clampToBand(normaliseUsername(shape(randomTwoDigits())), stem, band);
      if (candidate === null || seen.has(candidate)) continue;

      seen.add(candidate);
      out.push(candidate);
    }
  }

  return out;
}

/**
 * The random suffix that makes a username legal again after Premium lapses.
 *
 * Crockford base32 via `randomBase32`, which is what `generatePublicCode` uses — so the
 * alphabet has no `I`, `L`, `O` or `U`, and the result cannot be misread over the phone
 * or accidentally spell something. Lowercased to satisfy the charset.
 *
 * Sized to reach the free floor with the separator included, never merely appended: a
 * two-character Premium username needs five characters to clear seven, and a
 * six-character one needs one — so the suffix is computed from the shortfall rather
 * than fixed, and never produces a name longer than the maximum.
 */
export function complianceCandidate(currentLower: string): string {
  const shortfall = Math.max(0, USERNAME.DEFAULT_MIN_LENGTH - currentLower.length - 1);
  const length = Math.max(USERNAME.COMPLIANCE_SUFFIX_LENGTH, shortfall);
  const suffix = randomBase32(length).toLowerCase();

  const room = USERNAME.MAX_LENGTH - suffix.length - 1;
  return `${currentLower.slice(0, Math.max(1, room))}_${suffix}`;
}

function randomTwoDigits(): number {
  return Math.floor(Math.random() * 90) + 10;
}

/**
 * Fit a candidate inside the band, or reject it.
 *
 * Too long is fixable by trimming the stem — the decoration is what makes a suggestion
 * recognisable, so it is the stem that gives way. Too short is not fixable here without
 * inventing characters, so it is dropped and the next shape is tried.
 */
function clampToBand(
  candidate: string,
  stem: string,
  band: UsernameLengthBand,
): string | null {
  if (candidate.length > band.maxLength) {
    const excess = candidate.length - band.maxLength;
    const trimmedStem = stem.slice(0, Math.max(1, stem.length - excess));
    const trimmed = candidate.replace(stem, trimmedStem);
    return trimmed.length >= band.minLength && trimmed.length <= band.maxLength
      ? trimmed
      : null;
  }
  return candidate.length >= band.minLength ? candidate : null;
}
