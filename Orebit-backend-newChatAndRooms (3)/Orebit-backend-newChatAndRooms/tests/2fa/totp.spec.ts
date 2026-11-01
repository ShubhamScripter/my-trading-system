import { describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  base32Decode,
  base32Encode,
  generate,
  generateSecret,
  needsReseal,
  openSecret,
  otpauthUri,
  sealSecret,
  stepFor,
  TOTP_AAD_MIN_VERSION,
  verifyCode,
  type SealedSecret,
} from '../../src/2fa/totp';
import { TOTP } from '../../auth/auth.constants';
import { config } from '../../src/config';

/**
 * The RFC 6238 conformance test, and the reason writing TOTP by hand is
 * defensible rather than reckless.
 *
 * If the vectors below ever fail, the correct response is to delete
 * src/2fa/totp.ts and take `otplib` — NOT to adjust the expectations. Every value
 * here comes from the published specification, so a disagreement means our
 * implementation is wrong and every authenticator app in the world is right.
 */

describe('RFC 6238 Appendix B — the published test vectors', () => {
  // The spec's SHA-1 seed: the ASCII string "12345678901234567890", 20 bytes.
  const SEED = Buffer.from('12345678901234567890', 'ascii');

  // Appendix B tabulates 8-digit codes; the product uses 6, which is the same
  // algorithm reduced mod 10^6 — i.e. the last six digits of each tabulated value.
  const VECTORS: ReadonlyArray<{ unixTime: number; eightDigits: string }> = [
    { unixTime: 59, eightDigits: '94287082' },
    { unixTime: 1111111109, eightDigits: '07081804' },
    { unixTime: 1111111111, eightDigits: '14050471' },
    { unixTime: 1234567890, eightDigits: '89005924' },
    { unixTime: 2000000000, eightDigits: '69279037' },
    { unixTime: 20000000000, eightDigits: '65353130' },
  ];

  it.each(VECTORS)('matches the vector at T=$unixTime', ({ unixTime, eightDigits }) => {
    const step = stepFor(new Date(unixTime * 1000));
    expect(generate(SEED, step)).toBe(eightDigits.slice(-TOTP.DIGITS));
  });

  it('derives the step counter as floor(seconds / 30)', () => {
    // The vectors above would still pass if `stepFor` and `generate` were wrong in
    // compensating ways, so the counter is pinned on its own.
    expect(stepFor(new Date(59_000))).toBe(1n);
    expect(stepFor(new Date(1111111109_000))).toBe(37037036n);
  });
});

describe('verifyCode — the acceptance window and what it returns', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const now = new Date(1111111109_000);

  it('returns the step that matched, not merely true', () => {
    // The whole replay defence depends on this: the caller stores the step and
    // refuses anything at or below it next time. A boolean would leave it unable to
    // tell a fresh code from the same one presented twice.
    const step = stepFor(now);
    expect(verifyCode(secret, generate(secret, step), now)).toBe(step);
  });

  it('accepts the previous and next step, for clock skew', () => {
    const step = stepFor(now);
    expect(verifyCode(secret, generate(secret, step - 1n), now)).toBe(step - 1n);
    expect(verifyCode(secret, generate(secret, step + 1n), now)).toBe(step + 1n);
  });

  it('refuses a step outside the window', () => {
    const step = stepFor(now);
    expect(verifyCode(secret, generate(secret, step - 2n), now)).toBeNull();
    expect(verifyCode(secret, generate(secret, step + 2n), now)).toBeNull();
  });

  it('refuses a wrong code, a short code, and an empty one', () => {
    expect(verifyCode(secret, '000000', now)).toBeNull();
    expect(verifyCode(secret, '123', now)).toBeNull();
    expect(verifyCode(secret, '', now)).toBeNull();
  });

  it('refuses a code generated from a different secret', () => {
    const other = Buffer.from('09876543210987654321', 'ascii');
    expect(verifyCode(secret, generate(other, stepFor(now)), now)).toBeNull();
  });
});

describe('base32 — RFC 4648, because authenticator apps parse it', () => {
  it('round-trips a generated secret', () => {
    const secret = generateSecret();
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
  });

  it('encodes the RFC 4648 §10 vectors', () => {
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ');
    expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('tolerates the padding, whitespace and lowercase a human types', () => {
    expect(base32Decode('mzxw6ytboi')).toEqual(Buffer.from('foobar'));
    expect(base32Decode('MZXW 6YTB OI')).toEqual(Buffer.from('foobar'));
    expect(base32Decode('MZXW6YTBOI======')).toEqual(Buffer.from('foobar'));
  });

  it('uses the full alphabet including I, L, O and U', () => {
    // The distinction from `randomBase32`'s Crockford alphabet is load-bearing: an
    // app decoding an otpauth:// secret uses RFC 4648, so dropping those four
    // characters would produce a secret that every app reads as different bytes.
    for (const char of 'ILOU') {
      expect(() => base32Decode(char + 'A')).not.toThrow();
    }
  });

  it('refuses a character outside the alphabet', () => {
    expect(() => base32Decode('MZXW1')).toThrow(/invalid base32/);
  });
});

describe('the otpauth:// URI an authenticator scans', () => {
  it('carries the parameters every app needs to agree with us', () => {
    const uri = new URL(otpauthUri('MZXW6YTBOI', 'user@example.com'));

    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe('MZXW6YTBOI');
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe(String(TOTP.DIGITS));
    expect(uri.searchParams.get('period')).toBe(String(TOTP.STEP_SECONDS));
    expect(uri.searchParams.get('issuer')).toBe(TOTP.ISSUER);
  });

  it('percent-encodes the label, so an email address does not split it', () => {
    // Unencoded, the `@` and any `:` in the account name make the label ambiguous
    // and apps disagree about how to recover from that.
    expect(otpauthUri('AAAA', 'user@example.com')).toContain('user%40example.com');
  });
});

describe('the AES-256-GCM envelope around a secret at rest', () => {
  const USER = 'user-1';
  const FACTOR = 'factor-1';

  it('round-trips through seal and open', () => {
    const secret = generateSecret();
    expect(openSecret(sealSecret(secret, USER, FACTOR), USER, FACTOR)).toEqual(secret);
  });

  it('uses a fresh IV every time, so one key never encrypts twice under one nonce', () => {
    // IV reuse under a single key is the catastrophic failure mode for GCM, which
    // is why no code path accepts an IV from a caller.
    const secret = generateSecret();
    const a = sealSecret(secret, USER, FACTOR);
    const b = sealSecret(secret, USER, FACTOR);

    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('refuses tampered ciphertext rather than returning different bytes', () => {
    // This is what "authenticated" buys over CBC: a flipped bit is a decryption
    // failure, not a silently different secret that rejects every real code.
    const sealed = sealSecret(generateSecret(), USER, FACTOR);
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    expect(() => openSecret({ ...sealed, ciphertext: tampered }, USER, FACTOR)).toThrow();
  });

  it('refuses a tampered auth tag', () => {
    const sealed = sealSecret(generateSecret(), USER, FACTOR);
    const tag = new Uint8Array(sealed.tag);
    tag[0] = (tag[0] ?? 0) ^ 0xff;

    expect(() => openSecret({ ...sealed, tag }, USER, FACTOR)).toThrow();
  });
});

describe('the envelope is bound to the row that holds it (AAD)', () => {
  /**
   * ═══ WHAT THIS PREVENTS ═════════════════════════════════════════════════════
   *
   * Without additional authenticated data, the three secret columns were portable:
   * copy them from one factor row to another — or to another USER's row — and they
   * decrypted cleanly into a working authenticator. The auth tag proved the
   * ciphertext had not been altered and said nothing about where it belonged.
   *
   * These are the cases that failed to fail before.
   */

  const secret = generateSecret();

  it('refuses an envelope moved to a different factor of the same user', () => {
    const sealed = sealSecret(secret, 'user-1', 'factor-1');
    expect(() => openSecret(sealed, 'user-1', 'factor-2')).toThrow();
  });

  it('refuses an envelope moved to a different user', () => {
    // The sharper case: a database-level attacker copying one user's secret onto
    // their own row would have owned that user's authenticator.
    const sealed = sealSecret(secret, 'user-1', 'factor-1');
    expect(() => openSecret(sealed, 'user-2', 'factor-1')).toThrow();
  });

  it('opens for the exact pair it was sealed with', () => {
    const sealed = sealSecret(secret, 'user-1', 'factor-1');
    expect(openSecret(sealed, 'user-1', 'factor-1')).toEqual(secret);
  });

  it('stamps the ACTIVE key version on everything it seals', () => {
    // Not a constant: this is what makes rotation work. Point
    // TOTP_ACTIVE_KEY_VERSION at a new key and new enrollments follow it, while
    // rows already written keep naming the key that can still open them.
    expect(sealSecret(secret, 'user-1', 'factor-1').keyVersion).toBe(config.totpActiveKeyVersion);
  });
});

describe('version 1 rows keep working (the migration compatibility path)', () => {
  /**
   * v1 rows were sealed WITHOUT AAD. Opening one with AAD fails its tag check
   * exactly as a tampered row does, and the two are indistinguishable from the
   * bytes — which is why the version is stored rather than inferred. Had AAD simply
   * been added in place, every already-enrolled authenticator would have become
   * undecryptable, silently, on its owner's next sign-in.
   */

  /** A v1 envelope, built the way the old `sealSecret` did: no AAD. */
  function sealV1(secret: Buffer): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', config.totpSecretKey, iv);
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    return {
      ciphertext: new Uint8Array(ciphertext),
      iv: new Uint8Array(iv),
      tag: new Uint8Array(cipher.getAuthTag()),
      keyVersion: 1,
    };
  }

  it('opens a v1 envelope, ignoring AAD as v1 rules require', () => {
    const secret = generateSecret();
    // Any (user, factor) pair: v1 was not bound to one, so none of them matter.
    expect(openSecret(sealV1(secret), 'user-1', 'factor-1')).toEqual(secret);
    expect(openSecret(sealV1(secret), 'other-user', 'other-factor')).toEqual(secret);
  });

  it('flags a v1 row for re-sealing and an active-version row as current', () => {
    // How the old format drains: opportunistically, on the next successful
    // verification, with no backfill and no window where a user cannot sign in.
    // The same mechanism now drains a RETIRED KEY as well as an old format.
    expect(needsReseal(1)).toBe(true);
    expect(needsReseal(config.totpActiveKeyVersion)).toBe(false);
  });

  it('re-seals DOWNWARD too, so a bad rotation can be backed out', () => {
    // `!==` rather than `<`. Rolling TOTP_ACTIVE_KEY_VERSION back to a previous key
    // is a legitimate recovery, and rows already written under the newer one have to
    // move back for it to converge — under `<` they never would.
    expect(needsReseal(config.totpActiveKeyVersion + 1)).toBe(true);
  });

  it('sets AAD only from the version that introduced it', () => {
    // v1 predates binding, so opening one WITH AAD fails its tag exactly as a
    // tampered row does. This constant is what keeps the two apart.
    expect(TOTP_AAD_MIN_VERSION).toBe(2);
  });

  it('refuses a version this build does not know', () => {
    // Fails closed. Guessing a key would either fail the tag anyway or, worse,
    // succeed against the wrong one.
    const sealed = { ...sealV1(generateSecret()), keyVersion: 99 };
    expect(() => openSecret(sealed, 'user-1', 'factor-1')).toThrow(/no TOTP key for envelope version/i);
  });
});
