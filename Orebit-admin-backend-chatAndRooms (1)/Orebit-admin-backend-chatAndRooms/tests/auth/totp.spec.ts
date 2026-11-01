import { describe, expect, it } from 'vitest';
import { TOTP } from '../../auth/auth.constants';
import {
  base32Decode,
  base32Encode,
  generate,
  generateSecret,
  openSecret,
  otpauthUri,
  sealSecret,
  stepFor,
  verifyCode,
} from '../../auth/security/totp';

/**
 * ═══ THE TEST THAT JUSTIFIES HAND-WRITING TOTP ═══════════════════════════════
 *
 * auth/security/totp.ts implements RFC 6238 rather than taking a dependency, and
 * the whole argument for doing so is that the algorithm has published test
 * vectors. This file runs them.
 *
 * If the RFC vectors below ever fail, the correct response is to replace
 * totp.ts with `otplib` — NOT to adjust these expectations. They are the
 * specification, not a record of what our code happens to do.
 */

/**
 * RFC 6238 Appendix B.
 *
 * The published table is for a 20-byte ASCII seed "12345678901234567890" with
 * 8-digit codes. Our `generate` is pinned to `TOTP.DIGITS`, so the expectations
 * here are the low 6 digits of each published 8-digit value — which is exactly
 * what truncating the same `binary % 10^d` to fewer digits produces.
 */
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');

const RFC_VECTORS: readonly { readonly unixTime: number; readonly totp8: string }[] = [
  { unixTime: 59, totp8: '94287082' },
  { unixTime: 1111111109, totp8: '07081804' },
  { unixTime: 1111111111, totp8: '14050471' },
  { unixTime: 1234567890, totp8: '89005924' },
  { unixTime: 2000000000, totp8: '69279037' },
  { unixTime: 20000000000, totp8: '65353130' },
];

describe('TOTP — RFC 6238 vectors', () => {
  it('is configured for the parameters the vectors assume', () => {
    expect(TOTP.STEP_SECONDS).toBe(30);
    expect(TOTP.DIGITS).toBe(6);
  });

  it.each(RFC_VECTORS)('matches the published code at T=$unixTime', ({ unixTime, totp8 }) => {
    const step = stepFor(new Date(unixTime * 1000));
    // The RFC's 8-digit value truncated to our digit count.
    const expected = totp8.slice(-TOTP.DIGITS);
    expect(generate(RFC_SEED, step)).toBe(expected);
  });

  it('derives the same time steps the RFC tabulates', () => {
    // Appendix B lists these hex counter values alongside each time.
    expect(stepFor(new Date(59 * 1000))).toBe(0x1n);
    expect(stepFor(new Date(1111111109 * 1000))).toBe(0x23523eCn);
    expect(stepFor(new Date(1234567890 * 1000))).toBe(0x273ef07n);
  });
});

/**
 * ═══ THE ACCEPTANCE WINDOW: THE CURRENT STEP AND NOTHING ELSE ════════════════
 *
 * The required behaviour, and the whole point of this block:
 *
 *   current step   → ACCEPT
 *   previous step  → REJECT
 *   next step      → REJECT
 *
 * There is no clock-skew tolerance and no grace period. NOTHING in this file may
 * be relaxed to accept a previous-step code "because clocks drift" — that is the
 * exact allowance that was removed, and a server whose clock has drifted is an
 * operational problem (see the NTP note on `TOTP` in auth.constants.ts), not a
 * reason to widen the verifier.
 *
 * ─── Every instant here is a fixed epoch millisecond, deliberately ──────────
 *
 * `STEP_START` is chosen so that `1_700_000_010` seconds is exactly divisible by
 * `STEP_SECONDS`, which puts it precisely on a step boundary. That is what lets
 * the transition cases below name the 30-second rollover to the millisecond
 * instead of hoping the wall clock cooperates. With a zero window there is no
 * slack left to absorb a step change mid-test, so no case here may read the real
 * clock.
 */
describe('TOTP — the acceptance window', () => {
  /** Exactly on a step boundary: 1_700_000_010 / 30 = 56_666_667, no remainder. */
  const STEP_START = new Date(1_700_000_010_000);
  const STEP_N = stepFor(STEP_START);

  /**
   * FIXED secrets, not `generateSecret()`, and that matters more here than it did
   * before.
   *
   * Every "rejects" case below asserts that the code for one step does not match
   * the code for another. Two six-digit codes collide about once in a million, so
   * with a random secret each run those cases were a one-in-a-million false PASS —
   * and, worse, the transition case would occasionally false-FAIL. Pinning the
   * secret makes the whole block deterministic: the codes are fixed values, checked
   * distinct by the guard immediately below.
   */
  const secret = Buffer.from('00112233445566778899aabbccddeeff01234567', 'hex');
  const otherSecret = Buffer.from('ffeeddccbbaa99887766554433221100fedcba98', 'hex');

  it('is on a genuine step boundary, so the transition cases mean what they say', () => {
    expect(1_700_000_010 % TOTP.STEP_SECONDS).toBe(0);
    expect(STEP_N).toBe(56_666_667n);
    // The last millisecond of the step, and the first of the next.
    expect(stepFor(new Date(STEP_START.getTime() + 29_999))).toBe(STEP_N);
    expect(stepFor(new Date(STEP_START.getTime() + 30_000))).toBe(STEP_N + 1n);
  });

  /**
   * The precondition every rejection case rests on. If these ever collide, the
   * cases below would pass for the wrong reason — so the collision is asserted
   * away rather than assumed, and a failure here names the real problem instead of
   * surfacing as a baffling "expired code accepted".
   */
  it('has distinct codes across the steps under test', () => {
    const codes = [-2n, -1n, 0n, 1n, 2n].map((offset) => generate(secret, STEP_N + offset));
    expect(new Set(codes).size).toBe(codes.length);
    expect(generate(otherSecret, STEP_N)).not.toBe(generate(secret, STEP_N));
  });

  it('is configured to accept the current step only', () => {
    expect(TOTP.WINDOW).toBe(0);
  });

  it('accepts the current step and reports which step matched', () => {
    const code = generate(secret, STEP_N);
    expect(verifyCode(secret, code, STEP_START)).toBe(STEP_N);
  });

  /** The whole width of the step, so acceptance is not an artefact of landing on
   *  the boundary instant itself. */
  it('accepts the current step for its entire 30 seconds', () => {
    const code = generate(secret, STEP_N);
    for (const offsetMs of [0, 1, 15_000, 29_998, 29_999]) {
      expect(verifyCode(secret, code, new Date(STEP_START.getTime() + offsetMs))).toBe(STEP_N);
    }
  });

  /**
   * ═══ THE PREVIOUS STEP IS REJECTED ═════════════════════════════════════════
   *
   * This is the case the ±1-step window used to accept, and it is the reason this
   * change exists. An expired code gets no grace.
   */
  it('rejects the previous step', () => {
    const expired = generate(secret, STEP_N - 1n);
    expect(verifyCode(secret, expired, STEP_START)).toBeNull();
  });

  /** Symmetrically: a code the authenticator has not shown yet buys nothing. */
  it('rejects the next step', () => {
    const early = generate(secret, STEP_N + 1n);
    expect(verifyCode(secret, early, STEP_START)).toBeNull();
  });

  /**
   * ═══ THE ROLLOVER, TO THE MILLISECOND ══════════════════════════════════════
   *
   * The behaviour the requirement is written in terms of:
   *
   *   10:00:00.000  code A active   → A accepted
   *   10:00:29.999  still step N    → A accepted
   *   10:00:30.000  app shows B     → A REJECTED, B accepted
   */
  it('rejects a previous-step code the instant the authenticator rolls over', () => {
    const codeA = generate(secret, STEP_N);
    const codeB = generate(secret, STEP_N + 1n);

    const lastMsOfStepN = new Date(STEP_START.getTime() + 29_999);
    const firstMsOfStepNext = new Date(STEP_START.getTime() + 30_000);

    // Before the rollover: A is live, B is not yet.
    expect(verifyCode(secret, codeA, lastMsOfStepN)).toBe(STEP_N);
    expect(verifyCode(secret, codeB, lastMsOfStepN)).toBeNull();

    // One millisecond later: A is dead, B is live. No overlap, no grace.
    expect(verifyCode(secret, codeA, firstMsOfStepNext)).toBeNull();
    expect(verifyCode(secret, codeB, firstMsOfStepNext)).toBe(STEP_N + 1n);
  });

  /**
   * A code stays dead for the rest of time, not just for the step after its own.
   * Guards against a future "accept anything within N steps behind" reading.
   */
  it('keeps rejecting an expired code as later steps pass', () => {
    const codeA = generate(secret, STEP_N);
    for (const stepsLater of [1n, 2n, 3n, 10n]) {
      const at = new Date(STEP_START.getTime() + Number(stepsLater) * 30_000);
      expect(verifyCode(secret, codeA, at)).toBeNull();
    }
  });

  it('rejects two steps out in either direction', () => {
    expect(verifyCode(secret, generate(secret, STEP_N - 2n), STEP_START)).toBeNull();
    expect(verifyCode(secret, generate(secret, STEP_N + 2n), STEP_START)).toBeNull();
  });

  it('rejects a wrong code, a malformed code, and an empty string', () => {
    expect(verifyCode(secret, '000000', STEP_START)).toBeNull();
    expect(verifyCode(secret, 'abcdef', STEP_START)).toBeNull();
    expect(verifyCode(secret, '', STEP_START)).toBeNull();
  });

  it('rejects a code generated under a different secret', () => {
    expect(verifyCode(secret, generate(otherSecret, STEP_N), STEP_START)).toBeNull();
  });

  /**
   * The matched step is what `claimTotpStep` writes to `last_used_step`, so the
   * replay defence depends on this returning the step and not merely `true`.
   * Narrowing the window must not have changed the contract that carries it.
   */
  it('returns the step the replay defence needs to claim', () => {
    const matched = verifyCode(secret, generate(secret, STEP_N), STEP_START);
    expect(typeof matched).toBe('bigint');
    expect(matched).toBe(stepFor(STEP_START));
  });
});

describe('TOTP — base32', () => {
  /**
   * RFC 4648 §10. Our alphabet must be the standard one, NOT the Crockford
   * variant used elsewhere in this codebase for human-typed identifiers:
   * authenticator apps parse the otpauth `secret` parameter as RFC 4648, so
   * Crockford's omitted I/L/O/U would silently decode to different bytes than we
   * stored.
   */
  it.each([
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %j as %j per RFC 4648', (input, encoded) => {
    expect(base32Encode(Buffer.from(input, 'ascii'))).toBe(encoded);
  });

  it('round-trips arbitrary bytes', () => {
    for (const length of [1, 5, 10, 20, 32, 64]) {
      const bytes = generateSecret().subarray(0, Math.min(length, TOTP.SECRET_BYTES));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });

  it('tolerates lowercase, padding and whitespace, which people type by hand', () => {
    const bytes = Buffer.from('foobar', 'ascii');
    expect(base32Decode('mzxw6ytboi').equals(bytes)).toBe(true);
    expect(base32Decode('MZXW6YTBOI======').equals(bytes)).toBe(true);
    expect(base32Decode('MZXW 6YTB OI').equals(bytes)).toBe(true);
  });

  it('rejects a character outside the alphabet', () => {
    // `1`, `8`, `9` and `0` are all absent from RFC 4648 base32.
    expect(() => base32Decode('MZXW1YTB')).toThrow(/invalid base32/);
  });
});

describe('TOTP — the encryption envelope', () => {
  it('round-trips a secret through AES-256-GCM', () => {
    const secret = generateSecret();
    const sealed = sealSecret(secret);
    expect(openSecret(sealed).equals(secret)).toBe(true);
  });

  /**
   * IV reuse under one key is THE catastrophic failure mode for GCM, so the fact
   * that two encryptions of the same plaintext differ is a property worth
   * asserting rather than assuming.
   */
  it('uses a fresh IV per encryption, so identical secrets seal differently', () => {
    const secret = generateSecret();
    const a = sealSecret(secret);
    const b = sealSecret(secret);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('refuses to decrypt tampered ciphertext rather than returning wrong bytes', () => {
    const sealed = sealSecret(generateSecret());
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] as number) ^ 0xff;
    expect(() => openSecret({ ...sealed, ciphertext: tampered })).toThrow();
  });

  it('refuses to decrypt with a tampered auth tag', () => {
    const sealed = sealSecret(generateSecret());
    const tag = Buffer.from(sealed.tag);
    tag[0] = (tag[0] as number) ^ 0xff;
    expect(() => openSecret({ ...sealed, tag })).toThrow();
  });
});

describe('TOTP — the otpauth URI', () => {
  it('carries every parameter an authenticator app needs', () => {
    const secret = base32Encode(generateSecret());
    const uri = new URL(otpauthUri(secret, 'admin@orebit.io'));

    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe(secret);
    expect(uri.searchParams.get('issuer')).toBe(TOTP.ISSUER);
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe(String(TOTP.DIGITS));
    expect(uri.searchParams.get('period')).toBe(String(TOTP.STEP_SECONDS));
  });

  /** The `@` in an email is ambiguous in a URI path, so the label must be
   *  percent-encoded rather than interpolated raw. */
  it('percent-encodes the account label', () => {
    const uri = otpauthUri('AAAA', 'admin@orebit.io');
    expect(uri).toContain('admin%40orebit.io');
    expect(uri).not.toContain('admin@orebit.io');
  });

  it('produces a secret an app can decode back to our stored bytes', () => {
    const secret = generateSecret();
    const uri = new URL(otpauthUri(base32Encode(secret), 'admin@orebit.io'));
    const decoded = base32Decode(uri.searchParams.get('secret') as string);
    expect(decoded.equals(secret)).toBe(true);
  });
});
