import { describe, expect, it } from 'vitest';
import { passwordRequestSchema } from '../../../src/settings/password/password.dto';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * `.strict()` on every union member is a SECURITY control here, not tidiness, and
 * this file is what asserts it. Zod strips unknown keys by default, so without it:
 *
 *   a `set` body carrying `currentPassword` would have it silently dropped and
 *   succeed as the weakest of the three operations;
 *
 *   a `forgot` body carrying `hasPasskey: false` would look to the caller as though
 *   the server had accepted their assertion about the account, when nothing read it.
 *
 * The second is the one that matters. The wire half of "the frontend cannot claim no
 * factor exists" is that no such field parses; the other half — that no code reads
 * one — is asserted in `password.service.spec.ts`.
 *
 * What is deliberately NOT asserted here: whether a factor is REQUIRED. That needs
 * the account, so a body with no proof must parse and be refused by the service. A
 * test that expected a validation error for it would be asserting the bug.
 */

const SET = {
  action: 'set',
  password: 'Nu-Passw0rd!x9',
  confirmPassword: 'Nu-Passw0rd!x9',
  emailCode: '000000',
};

const RESET = { ...SET, action: 'reset', currentPassword: 'C0rrect-Horse!42' };
const FORGOT = { ...SET, action: 'forgot' };

/** A body with one key removed. `delete` on a copy rather than a rest-destructure,
 *  because the discarded binding would be a flagged unused variable — the lint rule's
 *  `argsIgnorePattern` covers parameters, not destructuring. */
function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...body };
  delete copy[key];
  return copy;
}

/** The issue paths a parse produced, sorted so an assertion does not depend on the
 *  order Zod happens to report them in. */
function pathsFor(body: unknown): string[] {
  const result = passwordRequestSchema.safeParse(body);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.')).sort();
}

describe('the three actions parse', () => {
  it.each([
    ['set', SET],
    ['reset', RESET],
    ['forgot', FORGOT],
  ])('%s', (_label, body) => {
    expect(passwordRequestSchema.safeParse(body).success).toBe(true);
  });

  it('refuses an unknown action rather than defaulting to one', () => {
    expect(pathsFor({ ...SET, action: 'change' })).toEqual(['action']);
  });
});

describe('.strict() — a field this operation does not declare is an ERROR', () => {
  it('refuses `currentPassword` on `set`, rather than dropping it', () => {
    // Dropped, this would succeed as `set` — the operation with the weakest
    // authorisation — while the caller believed they had proved the current password.
    expect(pathsFor({ ...SET, currentPassword: 'whatever' })).not.toEqual([]);
  });

  it('refuses a factor proof on `set` and `reset`, which cannot verify one', () => {
    expect(pathsFor({ ...SET, passkey: { id: 'c' } })).not.toEqual([]);
    expect(pathsFor({ ...RESET, totpCode: '123456' })).not.toEqual([]);
  });

  it.each([
    ['hasPasskey', { hasPasskey: false }],
    ['has2FA', { has2FA: false }],
    ['factorRequired', { factorRequired: false }],
    ['passwordSet', { passwordSet: false }],
    ['userId', { userId: '01940000-0000-7000-8000-000000000001' }],
  ])('refuses a client-asserted `%s` on `forgot`', (_label, extra) => {
    // None of these is a field any member declares, and none is read by any code.
    // Refusing them is what stops a client believing it can influence the decision.
    expect(pathsFor({ ...FORGOT, ...extra })).not.toEqual([]);
  });

  it('refuses an `operation` or `challengeId` borrowed from the Payment PIN shape', () => {
    // A plausible integration mistake, and one that must not half-work.
    expect(pathsFor({ ...FORGOT, operation: 'forgot' })).not.toEqual([]);
    expect(pathsFor({ ...FORGOT, challengeId: 'abc' })).not.toEqual([]);
  });
});

describe('confirmPassword', () => {
  it.each([
    ['set', SET],
    ['reset', RESET],
    ['forgot', FORGOT],
  ])('is compared on %s', (_label, body) => {
    expect(pathsFor({ ...body, confirmPassword: 'something-else' })).toEqual([
      'confirmPassword',
    ]);
  });

  it('is required, not optional', () => {
    expect(pathsFor(without(SET, 'confirmPassword'))).toContain('confirmPassword');
  });
});

describe('the new password', () => {
  it.each([
    ['too short', 'Sh0rt!'],
    ['no uppercase', 'nu-passw0rd!x9'],
    ['no digit', 'Nu-Password!xy'],
    ['no special character', 'NuPassw0rdxy9'],
  ])('refuses one that is %s', (_label, password) => {
    expect(pathsFor({ ...SET, password, confirmPassword: password })).toContain('password');
  });

  it('does NOT apply the policy to `currentPassword`', () => {
    // A password that predates the current policy must still be presentable, and
    // complaining about the composition of a guess narrows the search space. The
    // same distinction `auth/dto/password.dto.ts` draws.
    expect(
      passwordRequestSchema.safeParse({ ...RESET, currentPassword: 'old' }).success,
    ).toBe(true);
  });
});

describe('the factor proofs on `forgot`', () => {
  it('parses with neither — whether that is legal is the account\'s question', () => {
    expect(passwordRequestSchema.safeParse(FORGOT).success).toBe(true);
  });

  it.each([
    ['a passkey', { passkey: { id: 'credential-id' } }],
    ['a TOTP code', { totpCode: '123456' }],
  ])('parses with %s', (_label, proof) => {
    expect(passwordRequestSchema.safeParse({ ...FORGOT, ...proof }).success).toBe(true);
  });

  it('refuses BOTH, naming both fields', () => {
    // The ambiguity rule, which IS a shape question. Refused before any comparison
    // runs, so a caller sending everything learns nothing about which would verify.
    expect(pathsFor({ ...FORGOT, passkey: { id: 'c' }, totpCode: '123456' })).toEqual([
      'passkey',
      'totpCode',
    ]);
  });

  it('keeps the WebAuthn response passthrough — the verifier owns that shape', () => {
    // A hand-written schema here would duplicate the library's parsing while being
    // the thing that goes stale when the spec adds a field.
    const assertion = {
      id: 'credential-id',
      rawId: 'credential-id',
      type: 'public-key',
      response: { clientDataJSON: 'e30', authenticatorData: 'e30', signature: 'e30' },
      clientExtensionResults: {},
    };

    const result = passwordRequestSchema.safeParse({ ...FORGOT, passkey: assertion });
    expect(result.success).toBe(true);
    if (!result.success || result.data.action !== 'forgot') return;
    expect(result.data.passkey).toMatchObject(assertion);
  });

  it('still requires the `id` the lookup reads', () => {
    expect(pathsFor({ ...FORGOT, passkey: {} })).toContain('passkey.id');
  });
});

describe('the emailed code', () => {
  it.each([
    ['set', SET],
    ['reset', RESET],
    ['forgot', FORGOT],
  ])('is required on %s', (_label, body) => {
    expect(pathsFor(without(body, 'emailCode'))).toContain('emailCode');
  });

  it('is not shape-checked as six digits', () => {
    // Loose on purpose: a format rule at the door tells a caller which guesses were
    // well-formed before any comparison ran. The same argument as `codeSchema` in
    // 2fa.dto.ts, and the reason this is not `otpCodeSchema`.
    expect(passwordRequestSchema.safeParse({ ...SET, emailCode: 'ABC-123' }).success).toBe(
      true,
    );
  });
});
