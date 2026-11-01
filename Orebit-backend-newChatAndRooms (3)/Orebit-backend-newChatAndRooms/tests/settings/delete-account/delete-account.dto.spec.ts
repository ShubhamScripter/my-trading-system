import { describe, expect, it } from 'vitest';
import {
  deleteAccountRequestSchema,
  deleteVerifyRequestSchema,
  reactivateRequestSchema,
} from '../../../src/settings/delete-account/delete-account.dto';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * `.strict()` on the delete body is the assertion that matters most here, and it is a
 * security property rather than a tidiness one: that route wears `ElevationGuard`,
 * which spends the single-use ticket BEFORE the body is parsed. A silently dropped
 * field would mean the ticket was spent on a write the caller did not describe, and
 * there is no second ticket to retry with.
 *
 * The rest is the shape of the two ceremonies, and one deliberate LOOSENESS: the
 * reactivation email is bounded but not grammar-checked, because a strict address
 * schema on a public route answers differently for a well-formed address than a
 * malformed one, which is an oracle.
 */

describe('deleteVerifyRequestSchema', () => {
  it('accepts the challenge action alone', () => {
    expect(deleteVerifyRequestSchema.safeParse({ action: 'challenge' }).success).toBe(true);
  });

  it('requires the emailed code on the verify action', () => {
    // Required in the schema rather than in the service, so a client that forgets it
    // gets a validation error naming the field instead of a refusal that has already
    // charged an attempt.
    expect(deleteVerifyRequestSchema.safeParse({ action: 'verify' }).success).toBe(false);
    expect(
      deleteVerifyRequestSchema.safeParse({ action: 'verify', emailCode: '123456' }).success,
    ).toBe(true);
  });

  it('accepts either factor beside the code, and both at once', () => {
    // "Exactly one" is a statement about the account's enrolment as much as about the
    // body, so it is decided in the service against what the account holds — not here.
    for (const extra of [
      { totpCode: '654321' },
      { passkey: { id: 'credential-1' } },
      { totpCode: '654321', passkey: { id: 'credential-1' } },
    ]) {
      expect(
        deleteVerifyRequestSchema.safeParse({ action: 'verify', emailCode: '123456', ...extra })
          .success,
      ).toBe(true);
    }
  });

  it('refuses an unknown action and an unknown field', () => {
    expect(deleteVerifyRequestSchema.safeParse({ action: 'delete' }).success).toBe(false);
    expect(
      deleteVerifyRequestSchema.safeParse({ action: 'challenge', userId: 'someone-else' }).success,
    ).toBe(false);
  });

  it('refuses an empty or over-long code', () => {
    for (const emailCode of ['', 'x'.repeat(65)]) {
      expect(deleteVerifyRequestSchema.safeParse({ action: 'verify', emailCode }).success).toBe(
        false,
      );
    }
  });

  it('has no field naming an account', () => {
    // The acting account comes from the Principal and never from the body, so there is
    // nothing here on which to name somebody else's.
    const parsed = deleteVerifyRequestSchema.safeParse({ action: 'verify', emailCode: '123456' });
    expect(parsed.success && Object.keys(parsed.data)).toEqual(['action', 'emailCode']);
  });
});

describe('deleteAccountRequestSchema', () => {
  it('defaults the acknowledgement to false', () => {
    const parsed = deleteAccountRequestSchema.safeParse({});
    // False is both the honest default — "I did not acknowledge a prompt" — and the
    // safe one: it is the value that causes a refusal rather than a silent deletion on
    // the day a withdrawal provider is finally bound.
    expect(parsed.success && parsed.data.acknowledgeFundsForfeited).toBe(false);
  });

  it('accepts an explicit acknowledgement', () => {
    const parsed = deleteAccountRequestSchema.safeParse({ acknowledgeFundsForfeited: true });
    expect(parsed.success && parsed.data.acknowledgeFundsForfeited).toBe(true);
  });

  it('REFUSES an unknown field rather than dropping it', () => {
    // The load-bearing assertion in this file. `ElevationGuard` has already spent the
    // single-use ticket by the time this schema runs, so a silently ignored field would
    // mean the proof was spent on a request nobody can retry.
    expect(
      deleteAccountRequestSchema.safeParse({ acknowledgeFundsForfeited: true, purgeNow: true })
        .success,
    ).toBe(false);
    expect(deleteAccountRequestSchema.safeParse({ userId: 'someone-else' }).success).toBe(false);
  });

  it('refuses a non-boolean acknowledgement', () => {
    for (const value of ['true', 1, null]) {
      expect(
        deleteAccountRequestSchema.safeParse({ acknowledgeFundsForfeited: value }).success,
      ).toBe(false);
    }
  });

  it('carries no withdrawal address, amount, or destination of any kind', () => {
    // The boundary is a question, not a transfer. If this schema ever grows a field that
    // could move money, the Withdraw Funds API has leaked into the deletion feature.
    const shape = Object.keys(deleteAccountRequestSchema.shape);
    expect(shape).toEqual(['acknowledgeFundsForfeited']);
  });
});

describe('reactivateRequestSchema', () => {
  it('accepts the two actions with their fields', () => {
    expect(
      reactivateRequestSchema.safeParse({ action: 'challenge', email: 'ada@example.test' }).success,
    ).toBe(true);
    expect(
      reactivateRequestSchema.safeParse({
        action: 'verify',
        email: 'ada@example.test',
        code: '123456',
      }).success,
    ).toBe(true);
  });

  it('requires the address on both actions', () => {
    expect(reactivateRequestSchema.safeParse({ action: 'challenge' }).success).toBe(false);
    expect(reactivateRequestSchema.safeParse({ action: 'verify', code: '123456' }).success).toBe(
      false,
    );
  });

  it('bounds the address without grammar-checking it', () => {
    // Deliberately loose. A strict address grammar on a PUBLIC route answers differently
    // for a well-formed address than for a malformed one, which tells a caller which of
    // their guesses are worth sending again. Length bounds only; the route then answers
    // identically whatever it was given.
    expect(
      reactivateRequestSchema.safeParse({ action: 'challenge', email: 'not-an-address' }).success,
    ).toBe(true);
    expect(reactivateRequestSchema.safeParse({ action: 'challenge', email: 'a' }).success).toBe(
      false,
    );
    expect(
      reactivateRequestSchema.safeParse({ action: 'challenge', email: 'x'.repeat(255) }).success,
    ).toBe(false);
  });

  it('refuses unknown fields on an unauthenticated route', () => {
    expect(
      reactivateRequestSchema.safeParse({
        action: 'challenge',
        email: 'ada@example.test',
        userId: 'someone-else',
      }).success,
    ).toBe(false);
  });
});
