import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Cross-module pure helpers. No I/O, no framework, no domain knowledge.
 */

/**
 * UUIDv7 — a 48-bit big-endian millisecond timestamp followed by 74 bits of
 * randomness, per RFC 9562 §5.7.
 *
 * Used for every primary key in the schema, and node:crypto's `randomUUID()` is
 * deliberately not: that is a v4, which is uniformly random, so consecutive
 * inserts scatter across the index and every insert dirties a different page. A
 * v7 sorts by creation time, so inserts stay at the right edge of the B-tree and
 * `ORDER BY id` is chronological for free.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const millis = Date.now();

  // 48-bit timestamp, big-endian, in bytes 0..5.
  bytes[0] = (millis / 2 ** 40) & 0xff;
  bytes[1] = (millis / 2 ** 32) & 0xff;
  bytes[2] = (millis / 2 ** 24) & 0xff;
  bytes[3] = (millis / 2 ** 16) & 0xff;
  bytes[4] = (millis / 2 ** 8) & 0xff;
  bytes[5] = millis & 0xff;

  // Version 7 in the high nibble of byte 6; RFC 4122 variant in byte 8.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Crockford base32: no I, L, O or U.
 *
 * Excluding those four is the whole point — this alphabet is used for identifiers
 * a human reads off a screen and types somewhere else (`OREBiT…` user ids,
 * referral codes), and I/1, O/0 and L/1 are exactly the pairs that get
 * transcribed wrong. U is excluded so the encoding cannot spell obscenities.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `length` random Crockford base32 characters, from a CSPRNG. */
export function randomBase32(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CROCKFORD[randomInt(CROCKFORD.length)];
  }
  return out;
}

/** A zero-padded decimal string of exactly `digits` digits, from a CSPRNG. */
export function randomDigits(digits: number): string {
  const max = 10 ** digits;
  return String(randomInt(max)).padStart(digits, '0');
}

/**
 * Constant-time string comparison.
 *
 * ─── The guard has to measure what `timingSafeEqual` measures ───────────────
 *
 * `timingSafeEqual` compares BYTES, and throws unless both buffers are the same byte
 * length. The guard in front of it used to be `a.length !== b.length`, which counts
 * UTF-16 code units — a different quantity entirely for anything outside the range
 * where one character is one byte:
 *
 *   `safeEqual('é', 'a')`   both `.length === 1`, but 2 bytes against 1
 *   `safeEqual('\u{1F600}', 'ab')`   both `.length === 2`, but 4 bytes against 2
 *
 * So the guard agreed, `timingSafeEqual` was handed mismatched buffers, and it threw
 * `RangeError: Input buffers must have the same byte length`. Every caller here expects
 * a boolean and none of them catch, so the throw escaped as an unhandled error.
 *
 * On the CSRF path that mattered, because BOTH sides are supplied by the caller — the
 * `orebit_csrf` cookie against the `x-orebit-csrf` header. A single high byte in the
 * cookie turned the intended `csrf_invalid` 403 into an `internal_error` 500 with a
 * stack trace in the log, repeatable at will, and it happened before the session was
 * ever resolved. It failed closed, so it was never a bypass — it was a free way to
 * make the service log an error.
 *
 * Encoding first and comparing the buffers' own lengths is what makes the two
 * measurements the same measurement. The lengths themselves are not secret here (an
 * OTP is always 6 digits, a hash always 64 hex characters), so comparing them up front
 * leaks nothing. What this must not do is return early on the first differing byte,
 * which is exactly what `===` does.
 *
 * The invariant, stated once: `timingSafeEqual` is never reached with buffers of
 * different byte lengths, so this function returns `false` where it used to throw.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Milliseconds → a Date `seconds` in the future. */
export function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

export function isExpired(at: Date | null | undefined): boolean {
  return at === null || at === undefined || at.getTime() <= Date.now();
}
