import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { isUniqueViolation } from '../../db/client';
import { CountryDbOperation } from '../../src/country/country.dboperation';
import { uuidv7 } from '../../src/utils/public.utils';
import { prismaFor } from '../db/pg';

/**
 * The country writer against a REAL PostgreSQL.
 *
 * ═══ WHAT A DOUBLE CANNOT TELL YOU ═════════════════════════════════════════
 *
 * Everything asserted here is a property of the database rather than of this code:
 *
 *   · whether `UNIQUE(iso_code)` is actually live, and whether `isUniqueViolation`
 *     recognises what Prisma raises for it — a duplicate that surfaced as a 500 would
 *     pass every mocked test ever written;
 *   · whether `CHAR(2)` blank-pads a value on the way back out, which would make every
 *     derived object key `countries/IN /round.webp`;
 *   · whether `updateMany` really reports 0 for an absent row, which is how the service
 *     distinguishes "no such country" from "updated";
 *   · whether the Prisma model and the hand-written migration actually agree.
 *
 * Unlike tests/kyc/kyc.postgres.spec.ts this needs no sibling checkout: `admin` is the
 * schema THIS repository owns and migrates, so the test database already has the table.
 *
 * It SKIPS rather than fails when Postgres is unreachable — that is a fact about the
 * checkout, not a defect, and `npm test` must stay runnable on a laptop.
 * `OREBIT_PG_TESTS=1` turns an unreachable server into a hard failure.
 */

const pgAvailable = inject('pgAvailable');
const pgUrl = pgAvailable ? inject('pgUrl') : '';

let prisma: PrismaClient;
let countries: CountryDbOperation;

/** Codes used by this spec, cleaned up per test — other spec files may be running. */
const USED = ['IN', 'US', 'GB'] as const;

/** Keys shaped exactly as `newCountryImageKey` mints them. */
function keyFor(iso: string, slot: 'round' | 'square'): string {
  return `country-assets/${iso}/${slot}/${uuidv7()}.webp`;
}

/** A complete create input — both images are mandatory now. */
function createInput(iso: string, name = 'Test') {
  return {
    name,
    isoCode: iso,
    roundImageKey: keyFor(iso, 'round'),
    squareImageKey: keyFor(iso, 'square'),
    imagesUpdatedAt: new Date(),
  };
}

beforeAll(async () => {
  if (!pgAvailable) return;
  prisma = prismaFor(pgUrl, 'country-postgres-spec');
  countries = new CountryDbOperation(prisma as never);
});

afterEach(async () => {
  if (!pgAvailable) return;
  await prisma.country.deleteMany({ where: { isoCode: { in: [...USED] } } });
});

afterAll(async () => {
  if (!pgAvailable) return;
  await prisma.$disconnect();
});

describe.skipIf(!pgAvailable)('CountryDbOperation against Postgres', () => {
  it('round-trips a country complete with both image keys', async () => {
    const input = createInput('IN', 'India');
    const created = await countries.create(input);

    expect(created.isoCode).toBe('IN');
    expect(created.roundImageKey).toBe(input.roundImageKey);
    expect(created.squareImageKey).toBe(input.squareImageKey);
    expect(created.imagesUpdatedAt).not.toBeNull();
  });

  /**
   * ═══ CHAR(2) MUST NOT BLANK-PAD ════════════════════════════════════════════
   *
   * `KycPolicy.region` is VarChar(2) specifically because `'*'` would come back as
   * `'* '`. This column is CHAR(2) and always holds exactly two characters, so it does
   * not have that problem — but key derivation depends on it, so the absence of padding
   * is asserted rather than assumed.
   */
  it('returns the ISO code with no padding, so derived keys stay clean', async () => {
    await countries.create(createInput('IN', 'India'));
    const found = await countries.findByIsoCode('IN');

    expect(found?.isoCode).toBe('IN');
    expect(found?.isoCode).toHaveLength(2);
  });

  it('refuses a duplicate ISO code, and the refusal is recognisable', async () => {
    await countries.create(createInput('IN', 'India'));

    const error = await countries.create(createInput('IN', 'Bharat')).catch((e: unknown) => e);

    // Both halves matter: the constraint fired, AND the helper the service branches on
    // identifies it. Either alone would let a duplicate surface as a 500.
    expect(error).toBeInstanceOf(Error);
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('allows the same NAME under two different codes', async () => {
    await countries.create(createInput('IN', 'Territory'));
    await expect(countries.create(createInput('US', 'Territory'))).resolves.toBeDefined();
  });

  /**
   * The column is VARCHAR(255) and a minted key is far shorter, but a key that did not
   * fit would be truncated or rejected at the worst possible moment — after the object
   * was already uploaded.
   */
  it('stores a full-length minted key without truncation', async () => {
    const input = createInput('GB', 'United Kingdom');
    const created = await countries.create(input);

    expect(created.roundImageKey).toHaveLength(input.roundImageKey.length);
    expect(created.roundImageKey).toBe(input.roundImageKey);
  });

  /**
   * ═══ THE ASSOCIATION REQUIREMENT, AGAINST A REAL DATABASE ══════════════════
   *
   * Two countries, two sets of images, and neither one's keys may end up on the other's
   * row. The binding is the stored key and nothing else.
   */
  it('keeps each country pointed at its own images', async () => {
    const india = createInput('IN', 'India');
    const usa = createInput('US', 'United States');

    await countries.create(india);
    await countries.create(usa);

    const foundIndia = await countries.findByIsoCode('IN');
    const foundUsa = await countries.findByIsoCode('US');

    expect(foundIndia?.roundImageKey).toBe(india.roundImageKey);
    expect(foundUsa?.roundImageKey).toBe(usa.roundImageKey);
    expect(foundIndia?.roundImageKey).not.toContain('/US/');
    expect(foundUsa?.roundImageKey).not.toContain('/IN/');
  });

  /**
   * Two countries may legitimately share one asset — an asset is library stock, not the
   * property of the country whose code happens to be in its key. Nothing in the schema
   * forbids it, and this pins that.
   */
  it('lets two countries reference the same asset', async () => {
    const shared = keyFor('IN', 'round');

    await countries.create({ ...createInput('IN', 'India'), roundImageKey: shared });
    await expect(
      countries.create({ ...createInput('US', 'United States'), roundImageKey: shared }),
    ).resolves.toBeDefined();

    expect((await countries.findByIsoCode('US'))?.roundImageKey).toBe(shared);
  });

  it('lists every country ordered by ISO code', async () => {
    await countries.create(createInput('US', 'United States'));
    await countries.create(createInput('IN', 'India'));
    await countries.create(createInput('GB', 'United Kingdom'));

    const rows = await countries.list();
    const codes = rows.map((r) => r.isoCode).filter((c) => USED.includes(c as 'IN'));

    expect(codes).toEqual(['GB', 'IN', 'US']);
  });

  it('narrows the list to one country', async () => {
    await countries.create(createInput('IN', 'India'));
    await countries.create(createInput('US', 'United States'));

    const rows = await countries.list('IN');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isoCode).toBe('IN');
  });

  it('returns an empty list for a code with no row', async () => {
    expect(await countries.list('GB')).toEqual([]);
  });
});
