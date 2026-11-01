import { Prisma, type Country } from '@prisma/client';
import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_EVENT } from '../../auth/auth.dboperation';
import { ERR } from '../../src/contracts';
import { CountryImageStorageUnavailable } from '../../src/country/country.errors';
import { CountryService } from '../../src/country/country.service';
import { parseCountryImageKey, type CountryImageAsset } from '../../src/country/country.types';
import { ProblemException } from '../../src/http';
import { makePrincipal } from '../harness';

/**
 * What the country service stores, refuses and audits.
 *
 * The database, the audit writer and object storage are doubled; the image normaliser is
 * NOT — it is a pure function the service calls directly, and running it for real is what
 * makes the "invalid image" cases meaningful rather than a test of a stub.
 */

const ACTOR = makePrincipal({ adminId: '0195f0a0-aaaa-7000-8000-000000000001' });
const CLIENT = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceFingerprint: 'fp',
  userAgent: 'vitest',
};

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ROUND = 'country-assets/IN/round/0195f0a0-aaaa-7000-8000-000000000001.webp';
const SQUARE = 'country-assets/IN/square/0195f0a0-aaaa-7000-8000-000000000002.webp';

const CREATE = { name: 'India', isoCode: 'IN', roundImageKey: ROUND, squareImageKey: SQUARE };

function makeCountry(overrides: Partial<Country> = {}): Country {
  return {
    id: '0195f0a0-cccc-7000-8000-000000000001',
    name: 'India',
    isoCode: 'IN',
    roundImageKey: ROUND,
    squareImageKey: SQUARE,
    imagesUpdatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Country;
}

function asset(over: Partial<CountryImageAsset> = {}): CountryImageAsset {
  return {
    key: ROUND,
    url: `https://cdn.test/${ROUND}`,
    type: 'round',
    isoCode: 'IN',
    bytes: 1234,
    uploadedAt: NOW.toISOString(),
    ...over,
  };
}

let png: Buffer;

beforeAll(async () => {
  png = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  })
    .png()
    .toBuffer();
});

const countries = { list: vi.fn(), create: vi.fn(), findByIsoCode: vi.fn() };
const events = { record: vi.fn() };
const storage = {
  putWebp: vi.fn(),
  listImages: vi.fn(),
  exists: vi.fn(),
  publicUrl: vi.fn((key: string) => `https://cdn.test/${key}`),
};

function service(): CountryService {
  return new CountryService(countries as never, events as never, storage as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.publicUrl.mockImplementation((key: string) => `https://cdn.test/${key}`);
  storage.putWebp.mockResolvedValue(undefined);
  storage.exists.mockResolvedValue(true);
  storage.listImages.mockResolvedValue([]);
  events.record.mockResolvedValue(undefined);
});

describe('listImages — the image library', () => {
  /**
   * ═══ THE LIBRARY READS STORAGE, NEVER THE DATABASE ═════════════════════════
   *
   * This is what makes "select an existing image" possible for a country that does not
   * exist yet. If the library consulted `admin.countries`, a brand-new country's picker
   * would be empty and the whole flow would collapse back into create-first.
   */
  it('never touches the country table', async () => {
    await service().listImages({});
    expect(countries.list).not.toHaveBeenCalled();
    expect(countries.findByIsoCode).not.toHaveBeenCalled();
  });

  it('returns the assets storage reports', async () => {
    storage.listImages.mockResolvedValue([asset(), asset({ key: SQUARE, type: 'square' })]);

    const { images } = await service().listImages({});

    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ key: ROUND, type: 'round', isoCode: 'IN' });
  });

  /** An empty bucket is a legitimate answer, not an error. */
  it('returns an empty list for an empty bucket', async () => {
    storage.listImages.mockResolvedValue([]);
    await expect(service().listImages({})).resolves.toEqual({ images: [] });
  });

  it('filters by type, so a round picker never offers a square asset', async () => {
    storage.listImages.mockResolvedValue([asset(), asset({ key: SQUARE, type: 'square' })]);

    const { images } = await service().listImages({ type: 'round' });

    expect(images).toHaveLength(1);
    expect(images[0]?.type).toBe('round');
  });

  it('filters by ISO code', async () => {
    storage.listImages.mockResolvedValue([asset(), asset({ isoCode: 'US', key: 'x' })]);

    const { images } = await service().listImages({ isoCode: 'US' });

    expect(images).toHaveLength(1);
    expect(images[0]?.isoCode).toBe('US');
  });

  /**
   * ═══ AN UNREACHABLE BUCKET IS NOT AN EMPTY ONE ═════════════════════════════
   *
   * Collapsing the two would show an admin an empty picker and invite them to re-upload
   * flags that already exist.
   */
  it('reports a listing failure as 503 rather than an empty library', async () => {
    storage.listImages.mockRejectedValue(new CountryImageStorageUnavailable());

    const error = await service()
      .listImages({})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).type).toBe(ERR.COUNTRY_IMAGE_STORAGE_UNAVAILABLE);
    expect((error as ProblemException).detail).toBeUndefined();
  });
});

describe('uploadImage — putting an asset in the library', () => {
  /**
   * ═══ AN UPLOAD CREATES NO COUNTRY AND REQUIRES NONE ════════════════════════
   *
   * The change this whole refactor exists for. Previously the upload looked the country
   * up and 404'd without it, forcing an admin to create a half-built row before they
   * could choose a flag for it.
   */
  it('never reads or writes the country table', async () => {
    await service().uploadImage('IN', 'round', png, ACTOR, CLIENT);

    expect(countries.findByIsoCode).not.toHaveBeenCalled();
    expect(countries.create).not.toHaveBeenCalled();
    expect(countries.list).not.toHaveBeenCalled();
  });

  it('succeeds for a country that has never been created', async () => {
    const result = await service().uploadImage('ZW', 'square', png, ACTOR, CLIENT);
    expect(result.isoCode).toBe('ZW');
    expect(result.type).toBe('square');
  });

  it('returns a key and a usable URL for the client to preview and submit', async () => {
    const result = await service().uploadImage('IN', 'round', png, ACTOR, CLIENT);

    expect(parseCountryImageKey(result.key)).toEqual({ slot: 'round', isoCode: 'IN' });
    expect(result.url).toBe(`https://cdn.test/${result.key}`);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('stores normalised WebP, not the bytes it was given', async () => {
    await service().uploadImage('IN', 'round', png, ACTOR, CLIENT);

    const [key, stored] = storage.putWebp.mock.calls[0] as [string, Buffer];
    expect(stored.equals(png)).toBe(false);
    expect((await sharp(stored).metadata()).format).toBe('webp');
    expect(key).toMatch(/^country-assets\/IN\/round\//);
  });

  /**
   * ═══ EXISTING IMAGES SURVIVE A NEW UPLOAD ══════════════════════════════════
   *
   * The requirement that forced the key strategy to change. Under the old
   * `countries/{ISO}/round.webp` scheme these two calls produced ONE object and the
   * first image was gone — including one a live country still pointed at.
   */
  it('mints a new key every time, so nothing is ever overwritten', async () => {
    const first = await service().uploadImage('IN', 'round', png, ACTOR, CLIENT);
    const second = await service().uploadImage('IN', 'round', png, ACTOR, CLIENT);

    expect(second.key).not.toBe(first.key);

    const written = storage.putWebp.mock.calls.map(([k]) => k as string);
    expect(new Set(written).size).toBe(2);
  });

  it.each([
    ['invalid image', Buffer.from('not an image'), ERR.COUNTRY_IMAGE_INVALID],
    ['oversized image', Buffer.alloc(1_048_577, 1), ERR.COUNTRY_IMAGE_TOO_LARGE],
  ])('refuses an %s and stores nothing', async (_label, bytes, slug) => {
    await expect(
      service().uploadImage('IN', 'round', bytes, ACTOR, CLIENT),
    ).rejects.toMatchObject({ type: slug });

    expect(storage.putWebp).not.toHaveBeenCalled();
    expect(events.record).not.toHaveBeenCalled();
  });

  it('reports a storage failure as 503, disclosing nothing', async () => {
    storage.putWebp.mockRejectedValue(new CountryImageStorageUnavailable());

    const error = await service()
      .uploadImage('IN', 'round', png, ACTOR, CLIENT)
      .catch((e: unknown) => e);

    expect((error as ProblemException).type).toBe(ERR.COUNTRY_IMAGE_STORAGE_UNAVAILABLE);
    expect((error as ProblemException).detail).toBeUndefined();
    expect(events.record).not.toHaveBeenCalled();
  });

  /** A change to shared state that every other admin can then select from. */
  it('audits the upload with the key and type', async () => {
    const result = await service().uploadImage('IN', 'round', png, ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AUTH_EVENT.COUNTRY_IMAGE_UPLOADED,
        adminId: ACTOR.adminId,
        metadata: expect.objectContaining({ isoCode: 'IN', type: 'round', objectKey: result.key }),
      }),
    );
  });

  it('records only flat scalars, as the audit metadata type demands', async () => {
    await service().uploadImage('IN', 'round', png, ACTOR, CLIENT);

    const { metadata } = events.record.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    for (const value of Object.values(metadata)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });
});

describe('create — the catalogue row', () => {
  it('stores the chosen keys and returns both URLs', async () => {
    countries.create.mockResolvedValue(makeCountry());

    const result = await service().create(CREATE, ACTOR, CLIENT);

    expect(countries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'India',
        isoCode: 'IN',
        roundImageKey: ROUND,
        squareImageKey: SQUARE,
      }),
    );
    expect(result.roundImageUrl).toContain(ROUND);
    expect(result.squareImageUrl).toContain(SQUARE);
  });

  /**
   * ═══ A WELL-FORMED KEY IS NOT NECESSARILY A REAL OBJECT ════════════════════
   *
   * The DTO proves a key is ours and in the right slot; only storage can say whether
   * anything was ever uploaded there. Without this a caller could point a country at a
   * key nobody used and the flag would 404 in every client forever.
   */
  it('confirms both assets exist before inserting', async () => {
    countries.create.mockResolvedValue(makeCountry());

    await service().create(CREATE, ACTOR, CLIENT);

    expect(storage.exists).toHaveBeenCalledWith(ROUND);
    expect(storage.exists).toHaveBeenCalledWith(SQUARE);
  });

  it('refuses a key for an object that does not exist, naming the field', async () => {
    storage.exists.mockImplementation(async (key: string) => key !== SQUARE);

    const error = await service()
      .create(CREATE, ACTOR, CLIENT)
      .catch((e: unknown) => e);

    expect((error as ProblemException).type).toBe(ERR.VALIDATION_FAILED);
    expect((error as ProblemException).errors?.[0]?.path).toBe('squareImageKey');
    expect(countries.create).not.toHaveBeenCalled();
  });

  it('reports both missing assets at once', async () => {
    storage.exists.mockResolvedValue(false);

    const error = await service()
      .create(CREATE, ACTOR, CLIENT)
      .catch((e: unknown) => e);

    expect((error as ProblemException).errors).toHaveLength(2);
  });

  /**
   * "We could not ask" must never be reported as "your image is missing" — that would
   * tell an admin to re-upload a flag that is sitting right there.
   */
  it('reports a storage outage as 503, not as a missing image', async () => {
    storage.exists.mockRejectedValue(new CountryImageStorageUnavailable());

    const error = await service()
      .create(CREATE, ACTOR, CLIENT)
      .catch((e: unknown) => e);

    expect((error as ProblemException).type).toBe(ERR.COUNTRY_IMAGE_STORAGE_UNAVAILABLE);
    expect(countries.create).not.toHaveBeenCalled();
  });

  /**
   * A REAL `PrismaClientKnownRequestError`, because `isUniqueViolation` narrows on the
   * class and a duck-typed stand-in would pass while the production path fell to a 500.
   */
  it('reports a duplicate ISO code as its own 409 slug', async () => {
    countries.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
      }),
    );

    const error = await service()
      .create(CREATE, ACTOR, CLIENT)
      .catch((e: unknown) => e);

    expect((error as ProblemException).type).toBe(ERR.COUNTRY_ALREADY_EXISTS);
    expect((error as ProblemException).status).toBe(409);
  });

  it('rethrows an unrelated database error rather than calling it a duplicate', async () => {
    countries.create.mockRejectedValue(new Error('connection reset'));
    await expect(service().create(CREATE, ACTOR, CLIENT)).rejects.toThrow('connection reset');
  });

  it('audits the creation with the keys that were chosen', async () => {
    countries.create.mockResolvedValue(makeCountry());

    await service().create(CREATE, ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AUTH_EVENT.COUNTRY_CREATED,
        metadata: expect.objectContaining({
          isoCode: 'IN',
          name: 'India',
          roundImageKey: ROUND,
          squareImageKey: SQUARE,
        }),
      }),
    );
  });

  it('does not audit a create that was refused', async () => {
    storage.exists.mockResolvedValue(false);
    await service().create(CREATE, ACTOR, CLIENT).catch(() => undefined);
    expect(events.record).not.toHaveBeenCalled();
  });
});

describe('list — the catalogue', () => {
  /**
   * ═══ THE ASSOCIATION REQUIREMENT, END TO END ═══════════════════════════════
   *
   * Every row carries the name AND the code beside both URLs, and each country's URLs
   * are built from the keys ITS OWN row stores. Nothing is inferred from a filename.
   */
  it('returns identity and both URLs, with no cross-contamination', async () => {
    const usRound = 'country-assets/US/round/0195f0a0-bbbb-7000-8000-000000000001.webp';
    const usSquare = 'country-assets/US/square/0195f0a0-bbbb-7000-8000-000000000002.webp';

    countries.list.mockResolvedValue([
      makeCountry(),
      makeCountry({
        id: '0195f0a0-cccc-7000-8000-000000000002',
        isoCode: 'US',
        name: 'United States',
        roundImageKey: usRound,
        squareImageKey: usSquare,
      }),
    ]);

    const { countries: rows } = await service().list();
    const [india, usa] = rows;

    expect(india).toMatchObject({ name: 'India', isoCode: 'IN' });
    expect(india?.roundImageUrl).toContain(ROUND);
    expect(usa).toMatchObject({ name: 'United States', isoCode: 'US' });
    expect(usa?.roundImageUrl).toContain(usRound);

    expect(india?.roundImageUrl).not.toContain('/US/');
    expect(usa?.roundImageUrl).not.toContain('/IN/');
  });

  /** The catalogue reads the database; the library reads the bucket. Never both. */
  it('never reads object storage', async () => {
    countries.list.mockResolvedValue([makeCountry()]);
    await service().list();
    expect(storage.listImages).not.toHaveBeenCalled();
  });

  it('narrows to one country when a code is given', async () => {
    countries.list.mockResolvedValue([makeCountry()]);

    const { countries: rows } = await service().list('IN');

    expect(countries.list).toHaveBeenCalledWith('IN');
    expect(rows).toHaveLength(1);
  });

  it('404s for a valid code with no row, rather than returning an empty list', async () => {
    countries.list.mockResolvedValue([]);
    await expect(service().list('IN')).rejects.toMatchObject({ type: ERR.NOT_FOUND });
  });

  it('returns an empty list, not a 404, when no country exists at all', async () => {
    countries.list.mockResolvedValue([]);
    await expect(service().list()).resolves.toEqual({ countries: [] });
  });
});

describe('the full selection flow', () => {
  /**
   * ═══ LIBRARY → SELECT → CREATE → READ ══════════════════════════════════════
   *
   * The whole product flow in one test: an asset already in the bucket is listed, its
   * key is handed to create exactly as a frontend would, and the catalogue then serves a
   * URL built from that same key. No country existed when the asset was uploaded.
   */
  it('carries a selected asset key from the library into the catalogue', async () => {
    storage.listImages.mockResolvedValue([
      asset({ key: ROUND, type: 'round' }),
      asset({ key: SQUARE, type: 'square' }),
    ]);

    const { images } = await service().listImages({ isoCode: 'IN' });
    const round = images.find((i) => i.type === 'round');
    const square = images.find((i) => i.type === 'square');

    countries.create.mockImplementation(async (input: Record<string, unknown>) =>
      makeCountry({
        roundImageKey: input.roundImageKey as string,
        squareImageKey: input.squareImageKey as string,
      }),
    );

    const created = await service().create(
      {
        name: 'India',
        isoCode: 'IN',
        roundImageKey: round?.key as string,
        squareImageKey: square?.key as string,
      },
      ACTOR,
      CLIENT,
    );

    // The DB stores the exact key that was selected...
    expect(countries.create).toHaveBeenCalledWith(
      expect.objectContaining({ roundImageKey: ROUND, squareImageKey: SQUARE }),
    );

    // ...and the URL served back is built from it.
    expect(created.roundImageUrl).toBe(`https://cdn.test/${ROUND}`);
    expect(created.squareImageUrl).toBe(`https://cdn.test/${SQUARE}`);
  });

  /** The other branch: upload a new asset, then create from what the upload returned. */
  it('carries a freshly uploaded key into the catalogue', async () => {
    const round = await service().uploadImage('IN', 'round', png, ACTOR, CLIENT);
    const square = await service().uploadImage('IN', 'square', png, ACTOR, CLIENT);

    countries.create.mockImplementation(async (input: Record<string, unknown>) =>
      makeCountry({
        roundImageKey: input.roundImageKey as string,
        squareImageKey: input.squareImageKey as string,
      }),
    );

    const created = await service().create(
      { name: 'India', isoCode: 'IN', roundImageKey: round.key, squareImageKey: square.key },
      ACTOR,
      CLIENT,
    );

    expect(created.roundImageUrl).toContain(round.key);
    expect(created.squareImageUrl).toContain(square.key);
  });
});
