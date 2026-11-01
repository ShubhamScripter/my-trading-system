// Idempotency for chat actions that move money or create something that costs money (rulebook B-5; , ):
// a retry, a double click or a replayed request must have the effect of one request.
// The caller sends a key. The first request with a key stores the key with a fingerprint of what it asked for; the
// same key again with the same request gets the first answer; the same key with a DIFFERENT request is refused with
// 409, never silently treated as the first. The unique index that holds the key decides a race, in the database.
// Pure helpers only (no database, no clock): the table that holds the key belongs to the feature (ads, gifts).
import { createHash } from 'node:crypto';
import { ERR } from '../../../contracts';
import type { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import { refuse } from '../chat.moderation.service';

// What a client key may look like: 8 to 64 of letters, digits, `-` and `_`.
const KEY = /^[A-Za-z0-9_-]{8,64}$/;

// Canonical JSON: object keys sorted, so the same request always has the same text.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

// A short fingerprint of what a request asked for (key order and `undefined` fields do not matter).
export function fingerprint(request: unknown): string {
  return createHash('sha256').update(canonical(request)).digest('hex').slice(0, 32);
}

// The client's key if it is well formed, else a refusal that says what a key is.
export function requireKey(raw: string | null | undefined): string {
  const key = raw?.trim();
  if (!key || !KEY.test(key)) {
    throw refuse(
      ERR.VALIDATION_FAILED,
      CHAT_REFUSAL_REASONS.IDEMPOTENCY_KEY_REQUIRED,
      'Send a key of 8 to 64 letters, digits, - or _ so a retry never repeats this action',
    );
  }
  return key;
}

// The refusal for a key that is already used by a different request.
export function keyConflict(): ProblemException {
  return refuse(
    ERR.FORBIDDEN,
    CHAT_REFUSAL_REASONS.IDEMPOTENCY_KEY_REUSED,
    'This key was already used for a different request',
    {},
    409,
  );
}

// Throws the 409 unless the stored fingerprint is the one of this request.
export function assertSameRequest(storedFingerprint: string, request: unknown): void {
  if (storedFingerprint !== fingerprint(request)) throw keyConflict();
}
