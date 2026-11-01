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

/** A zero-padded decimal string of exactly `digits` digits, from a CSPRNG. */
export function randomDigits(digits: number): string {
  const max = 10 ** digits;
  return String(randomInt(max)).padStart(digits, '0');
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, and the lengths themselves are not
 * secret here (an OTP is always 6 digits, a hash always 64 hex characters), so
 * comparing lengths first leaks nothing. What it must not do is return early on
 * the first differing byte, which is exactly what `===` does.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Milliseconds → a Date `seconds` in the future. */
export function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

export function isExpired(at: Date | null | undefined): boolean {
  return at === null || at === undefined || at.getTime() <= Date.now();
}
