import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config';
import { TOTP } from '../../auth/auth.constants';

/**
 * TOTP — RFC 6238, on top of HOTP — plus the encryption envelope its secrets
 * need at rest.
 *
 * Ported from Orebit-admin-backend/auth/security/totp.ts, unchanged except for the
 * import paths and the issuer. It is deliberately a verbatim port: the algorithm is
 * the algorithm, and two implementations of it in one product would be two places
 * for the sign-bit bug below to be reintroduced.
 *
 * ─── Why this is hand-written rather than a dependency ──────────────────────
 *
 * It is ~60 lines of a precisely specified algorithm with published test vectors,
 * and this codebase already hand-rolls JWT handling rather than taking Passport
 * for the same reason: the surface is small, the spec is unambiguous, and the
 * failure mode is caught by a test rather than discovered in production.
 *
 * `tests/2fa/totp.spec.ts` runs the RFC 6238 Appendix B vectors against
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
// Standard RFC 4648 base32, NOT the Crockford variant `randomBase32` uses for
// human-typed identifiers elsewhere in the codebase. That distinction is
// load-bearing: authenticator apps parse the `secret` parameter of an otpauth://
// URI as RFC 4648, so Crockford's omitted I/L/O/U would silently produce a secret
// that every app decodes to different bytes than we stored.

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
 * Check a code against the steps around `at`, and return WHICH step matched.
 *
 * Returning the step rather than a boolean is what makes replay detection
 * possible: the caller records the matched step and refuses anything at or below
 * it next time. A boolean would leave the caller unable to distinguish a fresh
 * code from the same code presented twice.
 *
 * Every candidate is compared even after a match. That is a constant-time
 * property, not redundant work — returning early on the first hit would make the
 * response time reveal which step matched, and therefore the offset between the
 * server's clock and the authenticator's.
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
 * AES-256-GCM, the three columns of `TotpFactor`.
 *
 * GCM rather than CBC because it is authenticated: the tag makes tampering with
 * the ciphertext a decryption failure rather than a silently different secret.
 * A 12-byte IV is the GCM-recommended length, generated fresh per encryption —
 * reusing an IV under one key is the catastrophic failure mode for GCM, which is
 * why there is no code path here that accepts an IV from a caller.
 */
/**
 * `Uint8Array` rather than `Buffer`, because these three go straight into
 * `Bytes` columns and Prisma types those as `Uint8Array<ArrayBuffer>`. Buffer IS a
 * Uint8Array, so nothing is lost — but declaring the wider type here means the
 * conversion happens once, at the boundary that needs it, instead of at every call
 * site in the dboperation.
 */
export interface SealedSecret {
  readonly ciphertext: Uint8Array<ArrayBuffer>;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly tag: Uint8Array<ArrayBuffer>;
  /** Which key and rules sealed it — see the envelope-version note below. Stored on
   *  the row, because the bytes cannot say which key opens them. */
  readonly keyVersion: number;
}

/**
 * ═══ ENVELOPE VERSIONS ══════════════════════════════════════════════════════
 *
 * 1 — `TOTP_SECRET_KEY`, no additional authenticated data.
 * 2 — `TOTP_SECRET_KEY`, plus AAD binding the envelope to `(userId, factorId)`.
 * 3+ — a key from the `TOTP_KEYS` ring, same AAD binding as v2.
 *
 * Version 2 exists because v1 tied a secret to nothing. The tag proved the
 * ciphertext had not been altered and said nothing about WHERE it belonged, so the
 * three secret columns could be copied from one factor row to another — or to
 * another user's row — and would decrypt cleanly into a working authenticator.
 *
 * The version is stored rather than inferred because the two are indistinguishable
 * from the bytes: a v1 row opened with AAD fails its tag check exactly as a tampered
 * row does. Adding AAD in place would therefore have broken every enrolled
 * authenticator silently, and `openSecret` throws rather than returning wrong bytes,
 * so the symptom would have been every legitimate code rejected with no explanation.
 *
 * ─── One field, two meanings, and why that is still right ───────────────────
 *
 * Versions 1 and 2 differ in FORMAT and share a key; 3 and up differ in KEY and share
 * v2's format. That looks like two axes on one integer, and it is — but they are the
 * same axis in the only sense that matters here: "which procedure opens this row". A
 * second column would have to be read, written and kept consistent with this one to
 * answer a question this one already answers, and the two could then disagree.
 *
 * What the field must never do is grow a THIRD format. If AAD ever changes, the new
 * format needs its own range, and `aadFor` needs to select on it.
 */

/** The lowest version whose envelope carries AAD. Below it, `openSecret` must not set
 *  any, or the tag check fails on rows that were sealed before binding existed. */
export const TOTP_AAD_MIN_VERSION = 2;

/** What binds an envelope to its row. Order and separator are part of the format:
 *  change either and every bound row stops opening. The `v2` label names the AAD
 *  FORMAT, which v3+ rows reuse unchanged — it is not the row's key version. */
function aadFor(userId: string, factorId: string): Buffer {
  return Buffer.from(`totp:v2:${userId}:${factorId}`, 'utf8');
}

/**
 * The key for one envelope version.
 *
 * A function rather than a direct read, so a retired key stays reachable for as long
 * as rows still name its version: `openSecret` selects by the row's own label instead
 * of assuming the current key opened everything. That indirection was already here —
 * what it lacked was more than one key to choose between.
 *
 * `config.totpKeyRing` supplies them now. Versions 1 and 2 are seeded from
 * `TOTP_SECRET_KEY` (see `load()` in src/config.ts), so every row written before the
 * ring existed still opens; 3 and up come from `TOTP_KEYS`.
 */
function keyForVersion(version: number): Buffer {
  const key = config.totpKeyRing.get(version);
  if (key === undefined) {
    // A row labelled with a version this build has no key for — either a retired key
    // dropped from the ring too early, or a row from a newer deployment. Refusing is
    // the only safe answer: guessing a key would either fail the tag check anyway or,
    // worse, succeed against the wrong one.
    throw new Error(`no TOTP key for envelope version ${version}`);
  }
  return key;
}

/**
 * Seal a secret for one specific factor row.
 *
 * `userId` and `factorId` are required, and that is the fix rather than an
 * inconvenience: a signature that cannot be called without naming the row is a
 * signature that cannot produce an unbound envelope. The caller must therefore know
 * the factor id BEFORE sealing, which is why `createTotpFactor` generates the id
 * itself and passes it in.
 */
export function sealSecret(secret: Buffer, userId: string, factorId: string): SealedSecret {
  // Read per call rather than captured at module load. `config` is frozen at boot so
  // this cannot change under a running process today, but capturing it would make a
  // future reload silently keep sealing under the retired key — the one failure a
  // rotation mechanism must not have.
  const version = config.totpActiveKeyVersion;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyForVersion(version), iv);
  cipher.setAAD(aadFor(userId, factorId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  // Copied into plain Uint8Arrays rather than handed over as Buffers. A Buffer is a
  // Uint8Array, but it may be a VIEW onto Node's shared allocation pool — so the
  // bytes a `Bytes` column receives would depend on the view's offset surviving
  // every layer in between. Copying makes the envelope self-contained, and it is
  // three sub-kilobyte allocations per enrollment.
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    tag: new Uint8Array(cipher.getAuthTag()),
    keyVersion: version,
  };
}

/**
 * Throws on a bad tag, a wrong key, or an envelope that does not belong to the row
 * it was loaded from. The throw is not caught anywhere near the call site on purpose
 * — it means the database and `TOTP_SECRET_KEY` disagree, or a row has been tampered
 * with, and both are operational emergencies rather than wrong-code responses. It
 * surfaces as `internal_error`, which is the honest answer.
 */
export function openSecret(sealed: SealedSecret, userId: string, factorId: string): Buffer {
  const version = sealed.keyVersion;
  const decipher = createDecipheriv('aes-256-gcm', keyForVersion(version), sealed.iv);
  // v1 rows were sealed without AAD, so opening them WITH any would fail the tag.
  // This is the whole reason the version is stored — see the note above.
  if (version >= TOTP_AAD_MIN_VERSION) decipher.setAAD(aadFor(userId, factorId));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

/**
 * True when this row is not on the active key and should be re-sealed once it next
 * verifies. Lets an old format OR a retired key drain without a backfill or a
 * migration window.
 *
 * This is the whole rotation mechanism. Add a key to `TOTP_KEYS`, point
 * `TOTP_ACTIVE_KEY_VERSION` at it, and every factor moves across the next time its
 * owner signs in; once none are left on the old version, drop it from the ring.
 *
 * `!==` rather than `<`: rolling the pointer BACK to a previous version is a
 * legitimate way to back out a bad rotation, and rows already written under the
 * newer key must re-seal downward for that to converge. Under `<` they never would.
 */
export function needsReseal(keyVersion: number): boolean {
  return keyVersion !== config.totpActiveKeyVersion;
}

/** The sealed columns of a `TotpFactor`, as `openSecret` wants them. Here so the
 *  services that need a plaintext secret do not each spell out the mapping between
 *  column names and envelope fields. */
export function openFactorSecret(factor: {
  id: string;
  userId: string;
  secretCiphertext: Uint8Array<ArrayBuffer>;
  secretIv: Uint8Array<ArrayBuffer>;
  secretTag: Uint8Array<ArrayBuffer>;
  keyVersion: number;
}): Buffer {
  return openSecret(
    {
      ciphertext: factor.secretCiphertext,
      iv: factor.secretIv,
      tag: factor.secretTag,
      keyVersion: factor.keyVersion,
    },
    factor.userId,
    factor.id,
  );
}
