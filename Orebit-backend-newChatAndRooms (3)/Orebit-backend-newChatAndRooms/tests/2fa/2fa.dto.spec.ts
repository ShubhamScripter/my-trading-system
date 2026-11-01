import { describe, expect, it } from 'vitest';
import { twoFactorRequestSchema } from '../../src/2fa/2fa.dto';
import {
  ELEVATION_ACTIONS,
  REAUTH_INTENTS,
  isElevationAction,
} from '../../src/2fa/elevation';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * One question, and it is the load-bearing one for Settings → Social accounts:
 *
 *   can a client obtain an `account.social.link` ticket through
 *   `POST /auth/2fa {action:'reauth-verify'}`?
 *
 * It must not be able to. `reauthVerify` applies a policy that is wrong for that
 * action in both directions — it demands no emailed code where this one always
 * does, and it falls back to the account password where this one asks for nothing.
 * A ticket minted there would be a permit for the Settings write obtained on
 * strictly easier terms, which is a bypass rather than a mismatch.
 *
 * The narrowing lives in one place — `intentSchema` reads `REAUTH_INTENTS` rather
 * than `ELEVATION_ACTIONS` — and one place is easy to widen back by accident, since
 * nothing about it fails to compile. This file is what would notice.
 *
 * The second half asserts the wire contract did NOT change for anything that
 * existed before, which is the backward-compatibility claim the fourth action rests
 * on.
 */

const verify = (intent: string) =>
  twoFactorRequestSchema.safeParse({ action: 'reauth-verify', intent, password: 'pw' });

const challenge = (intent: string) =>
  twoFactorRequestSchema.safeParse({ action: 'reauth-challenge', intent });

describe('reauth intents are narrower than elevation actions', () => {
  it('refuses account.social.link at reauth-verify', () => {
    // The whole point. Its ceremony is `POST /settings/security/social-accounts/verify`,
    // which always spends an emailed code and never accepts a password.
    expect(verify('account.social.link').success).toBe(false);
  });

  it('refuses account.social.link at reauth-challenge too', () => {
    // Otherwise a client could read the advertised methods for an action it cannot
    // then prove here, which is an invitation to a dead end.
    expect(challenge('account.social.link').success).toBe(false);
  });

  it('still recognises account.social.link as a real elevation action', () => {
    // It IS a valid action — tickets are minted for it and `parseGrant` must accept
    // it — it simply is not mintable through this route.
    expect(isElevationAction('account.social.link')).toBe(true);
    expect(ELEVATION_ACTIONS).toContain('account.social.link');
    expect(REAUTH_INTENTS as readonly string[]).not.toContain('account.social.link');
  });
});

describe('the reauth-verify wire contract is unchanged', () => {
  it.each(['account.oauth.link', 'account.mfa.enroll', 'account.mfa.remove'])(
    'still accepts %s',
    (intent) => {
      expect(verify(intent).success).toBe(true);
      expect(challenge(intent).success).toBe(true);
    },
  );

  it('accepts exactly the three intents it accepted before', () => {
    // A count, deliberately: the failure this guards against is someone widening
    // `REAUTH_INTENTS` back to `ELEVATION_ACTIONS`, which no other assertion here
    // and nothing in the type system would catch.
    expect([...REAUTH_INTENTS]).toEqual([
      'account.oauth.link',
      'account.mfa.enroll',
      'account.mfa.remove',
    ]);
  });

  it('still refuses an intent that was never valid', () => {
    expect(verify('account.something.invented').success).toBe(false);
  });

  it('still requires an intent on reauth-verify', () => {
    expect(
      twoFactorRequestSchema.safeParse({ action: 'reauth-verify', password: 'pw' }).success,
    ).toBe(false);
  });

  it('still leaves it optional on reauth-challenge', () => {
    expect(twoFactorRequestSchema.safeParse({ action: 'reauth-challenge' }).success).toBe(true);
  });
});
