import { ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CountryImageStorageUnavailable } from '../../src/country/country.errors';
import { R2CountryImageStorage } from '../../src/country/country.storage';

/**
 * The R2 adapter's library half: `listImages` and `exists`.
 *
 * ═══ THE S3 CLIENT IS DOUBLED, THE ADAPTER IS NOT ══════════════════════════
 *
 * `send` is replaced and everything above it is the real thing — the prefix loop, the
 * pagination, the key parsing, the skip rule, the sort, and the error mapping. That is
 * where the logic worth testing lives; what is stubbed is the network.
 *
 * The adapter reads `config` at construction and `config.r2Enabled` is false under test
 * (tests/setup.ts sets no R2_* values), so the client field is null. These specs install
 * one directly, which is the only way to exercise the code paths behind that guard
 * without a live bucket.
 */

const UUID = '0195f0a0-aaaa-7000-8000-000000000001';

function object(key: string, over: { size?: number; at?: string } = {}) {
  return {
    Key: key,
    Size: over.size ?? 1024,
    LastModified: new Date(over.at ?? '2026-09-19T12:00:00.000Z'),
  };
}

/** A storage instance whose S3 client is `send`, and whose public base is set. */
function storageWith(send: ReturnType<typeof vi.fn>): R2CountryImageStorage {
  const storage = new R2CountryImageStorage();
  // Both fields are private and null under a test env; there is no constructor seam and
  // adding one purely for tests would be a production API nobody calls.
  Object.defineProperty(storage, 'client', { value: { send }, writable: true });
  Object.defineProperty(storage, 'base', { value: new URL('https://cdn.test/'), writable: true });
  return storage;
}

let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  send = vi.fn().mockResolvedValue({ Contents: [], IsTruncated: false });
});

describe('listImages', () => {
  it('returns an empty list for an empty bucket', async () => {
    await expect(storageWith(send).listImages()).resolves.toEqual([]);
  });

  it('reads both the current and the legacy prefix', async () => {
    await storageWith(send).listImages();

    const prefixes = send.mock.calls
      .map(([cmd]) => cmd as ListObjectsV2Command)
      .map((cmd) => cmd.input.Prefix);

    expect(prefixes).toContain('country-assets/');
    expect(prefixes).toContain('countries/');
  });

  it('maps an object to an asset with key, url, type and code', async () => {
    send.mockResolvedValueOnce({
      Contents: [object(`country-assets/IN/round/${UUID}.webp`, { size: 4096 })],
      IsTruncated: false,
    });

    const [asset] = await storageWith(send).listImages();

    expect(asset).toMatchObject({
      key: `country-assets/IN/round/${UUID}.webp`,
      type: 'round',
      isoCode: 'IN',
      bytes: 4096,
    });
    // `?v=` is the object's LastModified, so it is derived here rather than hardcoded.
    const stamp = new Date('2026-09-19T12:00:00.000Z').getTime();
    expect(asset?.url).toBe(
      `https://cdn.test/country-assets/IN/round/${UUID}.webp?v=${stamp}`,
    );
  });

  it('distinguishes round from square', async () => {
    send.mockResolvedValueOnce({
      Contents: [
        object(`country-assets/IN/round/${UUID}.webp`),
        object(`country-assets/IN/square/${UUID}.webp`),
      ],
      IsTruncated: false,
    });

    const types = (await storageWith(send).listImages()).map((a) => a.type);
    expect(types).toContain('round');
    expect(types).toContain('square');
  });

  /** Objects written before the library existed are still perfectly good flags. */
  it('includes legacy-layout objects', async () => {
    send
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
      .mockResolvedValueOnce({ Contents: [object('countries/IN/square.webp')], IsTruncated: false });

    const [asset] = await storageWith(send).listImages();
    expect(asset).toMatchObject({ key: 'countries/IN/square.webp', type: 'square', isoCode: 'IN' });
  });

  /**
   * ═══ AN UNPARSEABLE KEY IS SKIPPED, NEVER GUESSED AT ═══════════════════════
   *
   * The bucket may hold objects this module did not write. Inventing a type or a country
   * for one of them would be worse than omitting it — it would put a mystery object in a
   * flag picker and let an admin bind a country to it.
   */
  it('skips objects whose keys do not parse', async () => {
    send.mockResolvedValueOnce({
      Contents: [
        object('country-assets/IN/round/not-a-uuid.webp'),
        object('country-assets/XX/round/' + UUID + '.webp'),
        object('country-assets/IN/banner/' + UUID + '.webp'),
        object('some-other-thing/IN/round.webp'),
        object(`country-assets/IN/round/${UUID}.webp`),
      ],
      IsTruncated: false,
    });

    const assets = await storageWith(send).listImages();
    expect(assets).toHaveLength(1);
    expect(assets[0]?.key).toBe(`country-assets/IN/round/${UUID}.webp`);
  });

  it('tolerates an object with no key', async () => {
    send.mockResolvedValueOnce({ Contents: [{ Size: 1 }], IsTruncated: false });
    await expect(storageWith(send).listImages()).resolves.toEqual([]);
  });

  /**
   * A truncated first page would silently hide flags an admin is looking for, which
   * reads as "that image is gone" rather than "we stopped early".
   */
  it('follows pagination to exhaustion', async () => {
    send
      .mockResolvedValueOnce({
        Contents: [object(`country-assets/IN/round/${UUID}.webp`)],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      })
      .mockResolvedValueOnce({
        Contents: [object(`country-assets/US/round/${UUID}.webp`)],
        IsTruncated: false,
      })
      .mockResolvedValue({ Contents: [], IsTruncated: false });

    const assets = await storageWith(send).listImages();

    expect(assets).toHaveLength(2);
    const second = send.mock.calls[1]?.[0] as ListObjectsV2Command;
    expect(second.input.ContinuationToken).toBe('page-2');
  });

  /** The asset an admin just uploaded is the one they are looking for. */
  it('returns newest first', async () => {
    send.mockResolvedValueOnce({
      Contents: [
        object(`country-assets/IN/round/${UUID}.webp`, { at: '2026-01-01T00:00:00.000Z' }),
        object(`country-assets/US/round/${UUID}.webp`, { at: '2026-09-19T00:00:00.000Z' }),
      ],
      IsTruncated: false,
    });

    const assets = await storageWith(send).listImages();
    expect(assets.map((a) => a.isoCode)).toEqual(['US', 'IN']);
  });

  /**
   * ═══ AN UNREACHABLE BUCKET IS NOT AN EMPTY ONE ═════════════════════════════
   */
  it('throws rather than reporting an empty library when listing fails', async () => {
    send.mockRejectedValue(new Error('connection reset by peer'));

    const error = await storageWith(send)
      .listImages()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CountryImageStorageUnavailable);
    // The SDK's message names the endpoint and often the key id. None of it escapes.
    expect((error as Error).message).not.toContain('connection reset');
  });

  it('throws when storage is not configured at all', async () => {
    await expect(new R2CountryImageStorage().listImages()).rejects.toBeInstanceOf(
      CountryImageStorageUnavailable,
    );
  });
});

describe('exists', () => {
  it('sends a HEAD for the key, not a GET', async () => {
    send.mockResolvedValue({});
    await storageWith(send).exists('country-assets/IN/round/x.webp');

    const cmd = send.mock.calls[0]?.[0];
    expect(cmd).toBeInstanceOf(HeadObjectCommand);
    expect((cmd as HeadObjectCommand).input.Key).toBe('country-assets/IN/round/x.webp');
  });

  it('is true for an object that is there', async () => {
    send.mockResolvedValue({});
    await expect(storageWith(send).exists('k')).resolves.toBe(true);
  });

  it.each([
    ['a 404 status', { $metadata: { httpStatusCode: 404 } }],
    ['a NotFound name', { name: 'NotFound' }],
    ['a NoSuchKey name', { name: 'NoSuchKey' }],
  ])('is false for %s', async (_label, error) => {
    send.mockRejectedValue(error);
    await expect(storageWith(send).exists('k')).resolves.toBe(false);
  });

  /**
   * ═══ "WE COULD NOT ASK" IS NOT "IT IS NOT THERE" ═══════════════════════════
   *
   * Returning false on a network failure would tell an admin their image is missing and
   * send them off to re-upload a flag that is sitting right there.
   */
  it.each([
    ['a network failure', new Error('socket hang up')],
    ['a 403', { $metadata: { httpStatusCode: 403 } }],
    ['a 500', { $metadata: { httpStatusCode: 500 } }],
  ])('throws rather than returning false for %s', async (_label, error) => {
    send.mockRejectedValue(error);
    await expect(storageWith(send).exists('k')).rejects.toBeInstanceOf(
      CountryImageStorageUnavailable,
    );
  });

  it('throws when storage is not configured at all', async () => {
    await expect(new R2CountryImageStorage().exists('k')).rejects.toBeInstanceOf(
      CountryImageStorageUnavailable,
    );
  });
});
