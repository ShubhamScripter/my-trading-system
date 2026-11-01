import { describe, expect, it } from 'vitest';
import {
  PASSWORD_UNAVAILABLE,
  type PasswordAccount,
} from '../../../src/settings/password/password.types';
import {
  factorAvailable,
  factorMethodsFor,
  factorRequirementFor,
  factorUnavailableReason,
  resolveFactorProof,
  statusFor,
} from '../../../src/settings/password/password.utility';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * These are the pure functions the DTO and the service BOTH run, so a bug here is a
 * bug in two places at once — and the one that matters most is
 * `factorRequirementFor`, which is the single decision standing between a
 * factor-protected account and a password reset authorised by a mailbox alone.
 *
 * The four factor states are enumerated explicitly rather than parameterised over a
 * boolean pair, because "both enrolled" is not the conjunction of the other two: it
 * is the case where the caller CHOOSES, and the case a table-driven test is most
 * likely to under-specify.
 *
 * No I/O and no doubles. That is the point of these being pure: the account snapshot
 * is a literal, so every case is stated in one line and nothing about the test can
 * drift from what the service actually calls.
 */

const NO_FACTOR: PasswordAccount = {
  passwordSet: true,
  passkeyEnabled: false,
  totpEnrolled: false,
};
const PASSKEY_ONLY: PasswordAccount = { ...NO_FACTOR, passkeyEnabled: true };
const TOTP_ONLY: PasswordAccount = { ...NO_FACTOR, totpEnrolled: true };
const BOTH: PasswordAccount = { ...NO_FACTOR, passkeyEnabled: true, totpEnrolled: true };

describe('factorRequirementFor — the decision the frontend must not make', () => {
  it('demands nothing when no factor is enrolled', () => {
    expect(factorRequirementFor(NO_FACTOR)).toEqual({ required: false, methods: [] });
  });

  it('demands the passkey when only a passkey is enrolled', () => {
    expect(factorRequirementFor(PASSKEY_ONLY)).toEqual({
      required: true,
      methods: ['passkey'],
    });
  });

  it('demands the authenticator when only an authenticator is enrolled', () => {
    expect(factorRequirementFor(TOTP_ONLY)).toEqual({
      required: true,
      methods: ['authenticator'],
    });
  });

  it('offers EITHER when both are enrolled, passkey first', () => {
    // Order is asserted, not just membership: it drives which prompt a screen shows
    // by default, and one gesture beats six typed digits.
    expect(factorRequirementFor(BOTH)).toEqual({
      required: true,
      methods: ['passkey', 'authenticator'],
    });
  });

  it('is a function of the account alone — no request field can reach it', () => {
    // The anti-bypass property, asserted structurally. If this signature ever grows
    // a second parameter carrying request data, this test is where that is noticed.
    expect(factorRequirementFor.length).toBe(1);
  });

  it('ignores `passwordSet` — the requirement is about factors, not the password', () => {
    // `forgot` on an account with no password is refused earlier, by
    // `assertPasswordSet`. This function must not quietly double as that check, or
    // the two refusals would report the same cause with different words.
    expect(factorRequirementFor({ ...BOTH, passwordSet: false })).toEqual(
      factorRequirementFor(BOTH),
    );
  });
});

describe('factorAvailable / factorUnavailableReason', () => {
  it.each([
    ['passkey', PASSKEY_ONLY, true],
    ['authenticator', PASSKEY_ONLY, false],
    ['passkey', TOTP_ONLY, false],
    ['authenticator', TOTP_ONLY, true],
    ['passkey', BOTH, true],
    ['authenticator', BOTH, true],
  ] as const)('%s on that account → %s', (method, account, expected) => {
    expect(factorAvailable(method, account)).toBe(expected);
  });

  it('names the missing credential, not the other one', () => {
    // The reason a user sees. Getting these crossed tells someone to set up the
    // thing they already have.
    expect(factorUnavailableReason('passkey')).toBe(PASSWORD_UNAVAILABLE.NO_PASSKEY);
    expect(factorUnavailableReason('authenticator')).toBe(PASSWORD_UNAVAILABLE.NO_TOTP);
  });

  it('agrees with `factorMethodsFor` on every account', () => {
    // The two are used in different places — the status render lists, the service
    // checks one — and a disagreement would mean a screen offering a method the
    // service refuses. Asserted across all four states rather than trusted.
    for (const account of [NO_FACTOR, PASSKEY_ONLY, TOTP_ONLY, BOTH]) {
      for (const method of ['passkey', 'authenticator'] as const) {
        expect(factorAvailable(method, account)).toBe(
          factorMethodsFor(account).includes(method),
        );
      }
    }
  });
});

describe('resolveFactorProof — at most one, and never "at least one"', () => {
  it('reads no proof as no method, which is a valid body', () => {
    // NOT an error. Whether it is legal on THIS account needs I/O, so the DTO must
    // let it through and the service must be the one to refuse it.
    expect(resolveFactorProof({})).toEqual({ ok: true, method: null });
  });

  it('names the passkey path', () => {
    expect(resolveFactorProof({ passkey: { id: 'c' } })).toEqual({
      ok: true,
      method: 'passkey',
    });
  });

  it('names the authenticator path', () => {
    expect(resolveFactorProof({ totpCode: '123456' })).toEqual({
      ok: true,
      method: 'authenticator',
    });
  });

  it('refuses two proofs rather than picking one', () => {
    const resolved = resolveFactorProof({ passkey: { id: 'c' }, totpCode: '123456' });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;

    // BOTH fields are named. The mistake is the combination, and calling one of them
    // the intended one is exactly the silent resolution this refuses to perform.
    expect(resolved.problems.map((p) => p.path).sort()).toEqual(['passkey', 'totpCode']);
  });

  it('treats an explicitly undefined field as absent', () => {
    // How the parsed DTO actually arrives: optional Zod fields are `undefined`, not
    // missing. A presence check on `in` rather than `!== undefined` would read this
    // as two proofs and refuse a perfectly good request.
    expect(resolveFactorProof({ passkey: { id: 'c' }, totpCode: undefined })).toEqual({
      ok: true,
      method: 'passkey',
    });
  });
});

describe('statusFor — what the screen renders', () => {
  it('opens `set` and closes the other two when there is no password', () => {
    const status = statusFor({ ...NO_FACTOR, passwordSet: false });

    expect(status.passwordSet).toBe(false);
    expect(status.set).toEqual({ available: true });
    expect(status.reset.available).toBe(false);
    expect(status.reset.reason).toBe(PASSWORD_UNAVAILABLE.NOT_SET);
    expect(status.forgot.available).toBe(false);
  });

  it('closes `set` and opens the other two when there is one', () => {
    const status = statusFor(NO_FACTOR);

    expect(status.set.available).toBe(false);
    expect(status.set.reason).toBe(PASSWORD_UNAVAILABLE.ALREADY_SET);
    expect(status.reset).toEqual({ available: true });
    expect(status.forgot.available).toBe(true);
  });

  it('never opens `set` alongside `reset` — the three are mutually exclusive', () => {
    for (const passwordSet of [true, false]) {
      const status = statusFor({ ...BOTH, passwordSet });
      expect(status.set.available).toBe(!status.reset.available);
      expect(status.reset.available).toBe(status.forgot.available);
    }
  });

  it('tells the client whether `forgot` will demand a factor, and which', () => {
    // The field that makes the frontend simple: it renders from this and never
    // decides the rule.
    expect(statusFor(NO_FACTOR).forgot).toMatchObject({
      factorRequired: false,
      methods: [],
    });
    expect(statusFor(PASSKEY_ONLY).forgot).toMatchObject({
      factorRequired: true,
      methods: ['passkey'],
    });
    expect(statusFor(TOTP_ONLY).forgot).toMatchObject({
      factorRequired: true,
      methods: ['authenticator'],
    });
    expect(statusFor(BOTH).forgot).toMatchObject({
      factorRequired: true,
      methods: ['passkey', 'authenticator'],
    });
  });

  it('reports no factor requirement while there is no password to reset', () => {
    // `forgot` is unreachable on such an account, so promising a passkey prompt for
    // it would have a client render a step it can never take.
    const status = statusFor({ ...BOTH, passwordSet: false });

    expect(status.forgot.factorRequired).toBe(false);
    expect(status.forgot.methods).toEqual([]);
  });

  it('discloses no hash, no code and no factor identifier', () => {
    // Everything here describes the caller's own account behind their own session,
    // but "describes" must not become "enumerates": no credential id, no row id.
    const raw = JSON.stringify(statusFor(BOTH));

    expect(raw).not.toMatch(/argon2|hash|secret|credentialId|pk-|totp-/i);
  });
});
