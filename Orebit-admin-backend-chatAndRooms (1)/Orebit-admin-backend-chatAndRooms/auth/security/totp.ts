import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from '../../src/config';
import { TOTP } from '../auth.constants';

/**
 * TOTP — RFC 6238, on top of HOTP — plus the encryption envelope its secrets
 * need at rest.
 *
 * ─── Why this is hand-written rather than a dependency ──────────────────────
 *
 * It is ~60 lines of a precisely specified algorithm with published test vectors,
 * and this codebase already hand-rolls JWT handling rather than taking Passport
 * for the same reason: the surface is small, the spec is unambiguous, and the
 * failure mode is caught by a test rather than discovered in production.
 *
 * `tests/auth/totp.spec.ts` runs the RFC 6238 Appendix B vectors against
 * `generate`. That test is what makes writing this ourselves defensible — if it
 * ever fails, the correct response is to replace this file with `otplib`, not to
 * adjust the test.
 *
 * ─── Why SHA-1 ──────────────────────────────────────────────────────────────
 *
 * Because every authenticator app implements SHA-1 and almost none reliably
 * implement the SHA-256 variant that RFC 6238 also permits. This is not a place
 * where a stronger hash buys anything: HMAC-SHA1 has no practical weakness (the
 * collision attacks on bare SHA-1 do not transfer to HMAC), and the secret is
 * 160 bits of CSPRNG output. What actually bounds an attacker here is six digits
 * and five attempts, not the hash.
 */

// ─── base32, RFC 4648 ───────────────────────────────────────────────────────
//
// Standard RFC 4648 base32, NOT the Crockford variant used elsewhere in the
// codebase for human-typed identifiers. That distinction is load-bearing:
// authenticator apps parse the `secret` parameter of an otpauth:// URI as RFC
// 4648, so Crockford's omitted I/L/O/U would silently produce a secret that
// every app decodes to different bytes than we stored.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Trailing bits, left-aligned into a final character.
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(encoded: string): Buffer {
  // Padding is stripped and case is normalised, because both are things a person
  // typing a secret by hand gets wrong and neither changes the decoded bytes.
  const clean = encoded.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ─── HOTP / TOTP ────────────────────────────────────────────────────────────

/**
 * HOTP, RFC 4226 §5.3: HMAC-SHA1 the 8-byte big-endian counter under the secret,
 * take the low nibble of the last byte as an offset, read four bytes from there,
 * mask off the sign bit, and reduce mod 10^digits.
 *
 * The sign-bit mask is the step people omit. Without it the 31-bit value is read
 * as a signed 32-bit integer, so roughly half of all counters produce a negative
 * number and therefore a wrong code — intermittently, which is the worst way for
 * this to be broken.
 */
function hotp(secret: Buffer, counter: bigint, digits: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);

  const digest = createHmac('sha1', secret).update(counterBytes).digest();

  // `& 0x0f` — the last nibble, so the offset is always within the 20-byte digest.
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    ((digest[offset + 1] as number) << 16) |
    ((digest[offset + 2] as number) << 8) |
    (digest[offset + 3] as number);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The RFC 6238 time step for a given moment. Exported because the replay
 *  defence stores it, and a caller has to be able to name the step it accepted. */
export function stepFor(at: Date = new Date()): bigint {
  return BigInt(Math.floor(at.getTime() / 1000 / TOTP.STEP_SECONDS));
}

/** The code for one specific step. */
export function generate(secret: Buffer, step: bigint): string {
  return hotp(secret, step, TOTP.DIGITS);
}

/**
 * Check a code against the step `at` falls in, and return WHICH step matched.
 *
 * ═══ THE CURRENT STEP ONLY ═════════════════════════════════════════════════
 *
 * `TOTP.WINDOW` is 0, so the loop below has exactly one candidate: the step the
 * server is in right now. A code from the previous step — the one the
 * authenticator has just replaced — does not match and this returns null. There
 * is no clock-skew tolerance and no grace period; see the `TOTP` docblock in
 * auth.constants.ts for why, and for the NTP requirement that follows from it.
 *
 * Returning the step rather than a boolean is what makes replay detection
 * possible: the caller records the matched step and refuses anything at or below
 * it next time. A boolean would leave the caller unable to distinguish a fresh
 * code from the same code presented twice — which is still a live concern with a
 * zero window, because one step is 30 seconds wide and two requests can both
 * arrive inside it.
 *
 * ─── Why this is still a loop over `matched`, for one candidate ─────────────
 *
 * So that the window is a CONSTANT and not a shape baked into the control flow.
 * The two properties that matter if `TOTP.WINDOW` is ever non-zero again survive
 * here by construction: every candidate is compared even after a match, and the
 * function returns at the bottom rather than on the first hit. Returning early
 * would make the response time reveal which step matched, and therefore the
 * offset between the server's clock and the authenticator's. At zero there is
 * nothing to leak, which is why this shape is cheap to keep rather than pointless.
 */
export function verifyCode(secret: Buffer, code: string, at: Date = new Date()): bigint | null {
  const current = stepFor(at);
  let matched: bigint | null = null;

  for (let offset = -TOTP.WINDOW; offset <= TOTP.WINDOW; offset += 1) {
    const step = current + BigInt(offset);
    // `generate` output and `code` are both fixed-length digit strings of our own
    // formatting, so a length mismatch means a malformed input rather than a
    // near-miss, and there is nothing to leak by comparing lengths first.
    if (timingSafeStringEqual(generate(secret, step), code)) {
      matched = step;
    }
  }
  return matched;
}

/**
 * Constant-time comparison for two equal-length digit strings.
 *
 * Not `crypto.timingSafeEqual`, which throws on a length mismatch — that throw
 * would itself be an early exit, and this is called with caller-supplied input
 * whose length is not guaranteed.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─── secret generation and the encryption envelope ──────────────────────────

/** 20 bytes — the SHA-1 block size RFC 4226 assumes, and what every
 *  authenticator app expects. */
export function generateSecret(): Buffer {
  return randomBytes(TOTP.SECRET_BYTES);
}

/**
 * The `otpauth://` URI a QR code encodes.
 *
 * The label is `Issuer:account` and the `issuer` parameter repeats it — both are
 * required by the de-facto Google Authenticator spec, and apps disagree about
 * which one they read. Every component is percent-encoded because an email
 * address in a URI path is otherwise ambiguous at the `@`.
 */
export function otpauthUri(secretBase32: string, accountEmail: string): string {
  const label = encodeURIComponent(`${TOTP.ISSUER}:${accountEmail}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: TOTP.ISSUER,
    algorithm: 'SHA1',
    digits: String(TOTP.DIGITS),
    period: String(TOTP.STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * AES-256-GCM, the three columns of `AdminTotpFactor`.
 *
 * GCM rather than CBC because it is authenticated: the tag makes tampering with
 * the ciphertext a decryption failure rather than a silently different secret.
 * A 12-byte IV is the GCM-recommended length, generated fresh per encryption —
 * reusing an IV under one key is the catastrophic failure mode for GCM, which is
 * why there is no code path here that accepts an IV from a caller.
 */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
}

export function sealSecret(secret: Buffer): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.totpSecretKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/**
 * Throws on a bad tag or a wrong key, and the throw is not caught anywhere near
 * the call site on purpose — it means the database and `TOTP_SECRET_KEY` disagree,
 * which is an operational emergency rather than a wrong-code response. It
 * surfaces as `internal_error`, which is the honest answer.
 */
export function openSecret(sealed: SealedSecret): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', config.totpSecretKey, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}
