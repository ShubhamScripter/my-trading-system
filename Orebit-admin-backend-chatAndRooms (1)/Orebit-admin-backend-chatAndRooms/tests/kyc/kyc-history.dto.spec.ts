import { describe, expect, it } from 'vitest';
import {
  decodeKycHistoryCursor,
  encodeKycHistoryCursor,
} from '../../src/kyc/kyc-history.cursor';
import {
  kycHistoryAttemptQuerySchema,
  kycHistoryQuerySchema,
} from '../../src/kyc/kyc-history.dto';

/**
 * The KYC history query contract, and the cursor it pages with.
 *
 * Two things are proved here. The filters accept exactly what the founder requirement
 * names and refuse everything else — a compliance surface gains predicates only when
 * somebody has thought about what slicing the population discloses. And the cursor is
 * opaque in the strong sense: only a value this service issued is accepted, because the
 * pair inside it reaches a WHERE clause.
 */

const TS = '2026-09-15T12:00:00.000000Z';
const ID = '01a0af06-dbf9-7e09-937d-73ea819b23d3';

function parse(overrides: Record<string, unknown> = {}) {
  return kycHistoryQuerySchema.safeParse(overrides);
}

describe('the listing query', () => {
  it('needs nothing at all — an unfiltered listing is the default view', () => {
    const result = parse();
    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(50);
  });

  it('accepts every filter the requirement names', () => {
    const result = parse({
      userId: '01A07052-0000-7000-8000-000000000001',
      level: 'L2',
      status: 'IN_REVIEW',
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T00:00:00Z',
      limit: '25',
    });

    expect(result.success).toBe(true);
    // Coerced from text, because every query value arrives as a string.
    expect(result.success && result.data.limit).toBe(25);
    // Lower-cased, so a cursor or a caller cannot make the same id two different keys.
    expect(result.success && result.data.userId).toBe('01a07052-0000-7000-8000-000000000001');
  });

  it('refuses a level or status outside the consumer`s vocabulary', () => {
    // A status this list is missing would make a legitimate row unfilterable; one it
    // invented would silently return nothing and look like an empty history.
    expect(parse({ level: 'L3' }).success).toBe(false);
    expect(parse({ status: 'PENDING' }).success).toBe(false);
    expect(parse({ status: 'APPROVED' }).success).toBe(true);
    expect(parse({ status: 'IN_REVIEW' }).success).toBe(true);
  });

  it('refuses a malformed user id rather than passing it to a uuid cast', () => {
    expect(parse({ userId: 'not-a-uuid' }).success).toBe(false);
  });

  it('refuses a date range that runs backwards', () => {
    const result = parse({ from: '2026-09-30T00:00:00Z', to: '2026-09-01T00:00:00Z' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0]?.path).toEqual(['from']);
  });

  it('bounds the page size at both ends', () => {
    expect(parse({ limit: 0 }).success).toBe(false);
    expect(parse({ limit: 101 }).success).toBe(false);
    expect(parse({ limit: 100 }).success).toBe(true);
  });

  it('refuses unknown parameters outright rather than ignoring them', () => {
    // `.strict()`. A caller reaching for a filter that does not exist — or trying to
    // widen the projection — fails loudly instead of believing it worked.
    expect(parse({ sessionId: 'sess-1' }).success).toBe(false);
    expect(parse({ includeSealed: true }).success).toBe(false);
    expect(parse({ orderBy: 'status' }).success).toBe(false);
  });
});

describe('the attempt detail query', () => {
  it('requires a verification id, as a query parameter', () => {
    expect(kycHistoryAttemptQuerySchema.safeParse({ verificationId: ID }).success).toBe(true);
    expect(kycHistoryAttemptQuerySchema.safeParse({}).success).toBe(false);
    expect(kycHistoryAttemptQuerySchema.safeParse({ verificationId: 'nope' }).success).toBe(false);
  });

  it('takes nothing else', () => {
    expect(
      kycHistoryAttemptQuerySchema.safeParse({ verificationId: ID, userId: ID }).success,
    ).toBe(false);
  });
});

describe('the keyset cursor', () => {
  it('round-trips the pair it was built from', () => {
    expect(decodeKycHistoryCursor(encodeKycHistoryCursor(TS, ID))).toEqual([TS, ID]);
  });

  it('carries MICROSECONDS, because a truncated boundary compares wrongly', () => {
    // `timestamptz` stores microseconds and a JS Date truncates to milliseconds. A
    // cursor built from the truncated value would skip or repeat rows at the boundary.
    expect(() => encodeKycHistoryCursor('2026-09-15T12:00:00.000Z', ID)).toThrow();
    expect(() => encodeKycHistoryCursor(TS, ID)).not.toThrow();
  });

  it('refuses anything this service did not issue', () => {
    // The re-encode check. Without it the cursor is a caller-supplied WHERE clause
    // wearing a disguise.
    const forged = Buffer.from(JSON.stringify([TS, ID, 'extra'])).toString('base64url');
    const reordered = Buffer.from(JSON.stringify([ID, TS])).toString('base64url');
    const notJson = Buffer.from('nonsense').toString('base64url');

    for (const cursor of [forged, reordered, notJson, '', 'a'.repeat(513), 'has spaces', '../etc']) {
      expect(() => decodeKycHistoryCursor(cursor), cursor.slice(0, 20)).toThrow();
    }
  });

  it('refuses a cursor whose id is not a uuid', () => {
    const handmade = Buffer.from(JSON.stringify([TS, 'not-a-uuid'])).toString('base64url');
    expect(() => decodeKycHistoryCursor(handmade)).toThrow();
  });

  it('is rejected by the query schema too, not only by the decoder', () => {
    expect(parse({ cursor: 'tampered' }).success).toBe(false);
    expect(parse({ cursor: encodeKycHistoryCursor(TS, ID) }).success).toBe(true);
  });
});
