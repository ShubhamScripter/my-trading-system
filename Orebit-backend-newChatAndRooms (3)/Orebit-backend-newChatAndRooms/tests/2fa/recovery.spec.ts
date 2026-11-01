import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  normaliseRecoveryCode,
} from '../../src/2fa/recovery';
import { RECOVERY_CODES } from '../../auth/auth.constants';
import { policy } from '../../auth/limits';

/**
 * Recovery codes — the way back in when the authenticator is gone.
 *
 * The interesting properties are about a HUMAN handling them: an alphabet without
 * the characters people misread, and a normalisation generous enough to survive
 * however they type it back months later. Get either wrong and the failure mode is
 * a user who is locked out while holding a correct code.
 */

describe('generating a code', () => {
  it('uses the Crockford alphabet, which omits I, L, O and U', () => {
    // Deliberately NOT the RFC 4648 alphabet `totp.ts` uses. These are read off a
    // screen and typed back; those four are exactly what people confuse with 1 and
    // 0. The TOTP secret has the opposite requirement because an app parses it.
    const codes = Array.from({ length: 200 }, generateRecoveryCode).join('');
    expect(codes).not.toMatch(/[ILOU]/);
    expect(codes.replace(/-/g, '')).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('is hyphenated into two groups, purely so it is legible', () => {
    expect(generateRecoveryCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]+-[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('carries the configured number of characters', () => {
    expect(generateRecoveryCode().replace('-', '')).toHaveLength(RECOVERY_CODES.LENGTH);
  });

  it('issues a full set, all distinct', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(policy().MFA.RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(policy().MFA.RECOVERY_CODE_COUNT);
  });
});

describe('normalising what a person actually types', () => {
  const CODE = '4X7K9-M2QRT';

  it.each([
    ['as printed', '4X7K9-M2QRT'],
    ['lowercase', '4x7k9-m2qrt'],
    ['no hyphen', '4X7K9M2QRT'],
    ['spaces instead', '4X7K9 M2QRT'],
    ['pasted with trailing whitespace', '  4X7K9-M2QRT\n'],
    ['mixed case and stray punctuation', '4x7k9 – m2qrt.'],
  ])('accepts it %s', (_name, typed) => {
    // Being generous costs nothing: the value is compared against a hash of the same
    // normalisation, so anything that normalises to the wrong string simply fails to
    // match. What it buys is a user not being locked out by a keyboard.
    expect(normaliseRecoveryCode(typed)).toBe(normaliseRecoveryCode(CODE));
    expect(hashRecoveryCode(typed)).toBe(hashRecoveryCode(CODE));
  });

  it('does not collapse two genuinely different codes', () => {
    expect(hashRecoveryCode('4X7K9-M2QRT')).not.toBe(hashRecoveryCode('4X7K9-M2QRS'));
  });
});

describe('hashing', () => {
  it('never returns the plaintext', () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);

    expect(hash).not.toContain(code.replace('-', ''));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable, so a stored hash keeps matching', () => {
    const code = generateRecoveryCode();
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code));
  });
});
