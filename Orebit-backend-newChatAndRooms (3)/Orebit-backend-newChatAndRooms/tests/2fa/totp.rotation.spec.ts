import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  LEGACY_KEY_VERSIONS,
  resealFactor,
  summariseRing,
  type KeyVersionCount,
} from '../../src/2fa/totp.rotation';
import { openFactorSecret, sealSecret } from '../../src/2fa/totp';
import { config } from '../../src/config';

/**
 * ═══ THE QUESTION THIS ANSWERS ══════════════════════════════════════════════
 *
 * "Is it safe to drop this key?" — asked by an operator part-way through a rotation,
 * answered wrongly at exactly one's peril: dropping a key that live rows still name
 * does not fail loudly at deploy time, it fails as `internal_error` inside the
 * sign-ins of whichever users had not verified recently.
 *
 * `summariseRing` takes the ring as an argument rather than reading `config`, which
 * is what lets these tests describe rings this process does not have — including the
 * one state a process holding the key cannot reach, `orphaned`.
 */

/**
 * A census, as a tuple per version.
 *
 * `antiPhishing` defaults to zero so every existing case still reads as a statement
 * about TOTP factors alone. The cases that exercise the shared key ring pass it
 * explicitly — see the `shared key ring` block below for why a version can be held open
 * by rows this tool cannot re-seal.
 */
const counts = (
  ...rows: [version: number, live: number, deleted?: number, antiPhishing?: number][]
): KeyVersionCount[] =>
  rows.map(([keyVersion, live, deleted = 0, antiPhishing = 0]) => ({
    keyVersion,
    live,
    deleted,
    antiPhishing,
  }));

describe('summariseRing — verdicts', () => {
  it('names the active version active, even with no rows on it yet', () => {
    const status = summariseRing(counts([2, 40]), [1, 2, 3], 3);

    expect(status.versions.find((row) => row.version === 3)?.verdict).toBe('active');
  });

  it('calls a non-active version with live rows and a present key draining', () => {
    const status = summariseRing(counts([2, 40]), [1, 2, 3], 3);

    expect(status.versions.find((row) => row.version === 2)?.verdict).toBe('draining');
    expect(status.pendingReseal).toBe(40);
  });

  it('calls a non-active version with no live rows retirable', () => {
    const status = summariseRing(counts([2, 0], [3, 40]), [1, 2, 3], 3);

    expect(status.versions.find((row) => row.version === 2)?.verdict).toBe('retirable');
  });

  it('calls live rows whose key has been dropped orphaned, not draining', () => {
    // The failure this whole module exists to make visible: version 3 was removed from
    // TOTP_KEYS while forty factors still named it. Those users cannot sign in.
    const status = summariseRing(counts([3, 40], [4, 10]), [1, 2, 4], 4);

    expect(status.versions.find((row) => row.version === 3)?.verdict).toBe('orphaned');
    expect(status.orphaned).toEqual([3]);
  });

  it('lists a ring version the database has never used, so it can be cleaned up', () => {
    const status = summariseRing(counts([4, 10]), [1, 2, 3, 4], 4);

    const three = status.versions.find((row) => row.version === 3);
    expect(three).toMatchObject({ live: 0, inRing: true, verdict: 'retirable' });
  });
});

describe('summariseRing — safeToDrop', () => {
  it('offers a drained non-legacy version', () => {
    const status = summariseRing(counts([3, 0], [4, 10]), [1, 2, 3, 4], 4);

    expect(status.safeToDrop).toEqual([3]);
  });

  it('never offers a version that still has live rows', () => {
    const status = summariseRing(counts([3, 1], [4, 10]), [1, 2, 3, 4], 4);

    expect(status.safeToDrop).toEqual([]);
  });

  it('never offers the active version', () => {
    // Zero rows on the active key is the ordinary state immediately after pointing
    // TOTP_ACTIVE_KEY_VERSION at a new one. Offering it would be catastrophic advice.
    const status = summariseRing(counts([3, 40]), [1, 2, 3, 4], 4);

    expect(status.safeToDrop).not.toContain(4);
  });

  it('never offers 1 or 2, because they share one environment variable', () => {
    // Both are seeded from TOTP_SECRET_KEY, so "drop version 1" is not an action that
    // exists — the only lever is the shared key, and pulling it takes v2 with it.
    const status = summariseRing(counts([1, 0], [2, 0], [4, 10]), [1, 2, 4], 4);

    expect(status.safeToDrop).toEqual([]);
    for (const legacy of LEGACY_KEY_VERSIONS) expect(status.safeToDrop).not.toContain(legacy);
  });

  it('does not offer a version that is already out of the ring', () => {
    // It has no rows and no key: there is nothing left to do, so reporting it as a
    // pending action would be a chore that can never be completed.
    const status = summariseRing(counts([4, 10]), [1, 2, 4], 4);

    expect(status.safeToDrop).toEqual([]);
  });
});

describe('summariseRing — the legacy key', () => {
  it('is retirable only once BOTH legacy formats have drained', () => {
    const oneLeft = summariseRing(counts([1, 3], [2, 0], [4, 10]), [1, 2, 4], 4);
    expect(oneLeft.legacyKeyRetirable).toBe(false);

    const twoLeft = summariseRing(counts([1, 0], [2, 7], [4, 10]), [1, 2, 4], 4);
    expect(twoLeft.legacyKeyRetirable).toBe(false);

    const drained = summariseRing(counts([1, 0], [2, 0], [4, 10]), [1, 2, 4], 4);
    expect(drained.legacyKeyRetirable).toBe(true);
  });

  it('is never retirable while a legacy version is the active one', () => {
    // v2 active with no rows yet is a fresh deployment, not a drained one — new
    // enrollments are about to be sealed under exactly that key.
    const status = summariseRing(counts([1, 0], [2, 0]), [1, 2], 2);

    expect(status.legacyKeyRetirable).toBe(false);
  });

  it('ignores soft-deleted rows when deciding, but still reports them', () => {
    // Nothing reads a soft-deleted factor, so it cannot block a retirement — but an
    // operator seeing "0 live" deserves to know the rows are still there.
    const status = summariseRing(counts([1, 0, 12], [2, 0, 4], [4, 10]), [1, 2, 4], 4);

    expect(status.legacyKeyRetirable).toBe(true);
    expect(status.versions.find((row) => row.version === 1)?.deleted).toBe(12);
  });
});

describe('summariseRing — pendingReseal', () => {
  it('counts every live row off the active version and nothing else', () => {
    const status = summariseRing(counts([1, 5, 99], [2, 7], [4, 10]), [1, 2, 4], 4);

    // 5 + 7, not the 10 already on v4 and not the 99 soft-deleted.
    expect(status.pendingReseal).toBe(12);
  });

  it('is zero once everything is on the active version', () => {
    expect(summariseRing(counts([4, 10]), [1, 2, 4], 4).pendingReseal).toBe(0);
  });

  it('ignores anti-phishing rows, which this tool does not re-seal', () => {
    // v2 holds no factors and 500 anti-phishing codes. `pendingReseal` is what
    // `totp:rotate` would rewrite, and it walks `totp_factors` only — so reporting the
    // codes here would promise work the backfill does not do. They still block the
    // retirement; that is `verdict`'s job, asserted below.
    const status = summariseRing(counts([2, 0, 0, 500], [4, 10]), [1, 2, 4], 4);

    expect(status.pendingReseal).toBe(0);
    expect(status.versions.find((row) => row.version === 2)?.verdict).toBe('draining');
  });
});

/**
 * ═══ THE SHARED KEY RING ════════════════════════════════════════════════════
 *
 * `config.totpKeyRing` also seals the anti-phishing code (src/utils/sealed-secret.ts).
 * These are the cases that make that safe, and they are the reason
 * `KeyVersionCount.antiPhishing` exists at all.
 *
 * The failure they exist to prevent is specific and silent: a version with no TOTP
 * factors reads as `retirable`, an operator drops it from `TOTP_KEYS`, and every
 * account whose code was sealed under it stops seeing that code in its email — with no
 * error anywhere, because `antiPhishingCodeOf` is deliberately built to swallow a
 * decrypt failure rather than break a security email.
 */
describe('summariseRing — the shared key ring', () => {
  it('does not call a version retirable while anti-phishing rows still name it', () => {
    // The exact trap: zero factors, zero soft-deleted, 8412 codes.
    const status = summariseRing(counts([2, 0, 0, 8412], [4, 10]), [1, 2, 4], 4);

    expect(status.versions.find((row) => row.version === 2)?.verdict).toBe('draining');
    expect(status.safeToDrop).not.toContain(2);
  });

  it('calls a version retirable once neither factors nor codes name it', () => {
    const status = summariseRing(counts([3, 0, 0, 0], [4, 10]), [1, 3, 4], 4);

    expect(status.versions.find((row) => row.version === 3)?.verdict).toBe('retirable');
    expect(status.safeToDrop).toContain(3);
  });

  it('calls anti-phishing rows with no key orphaned, not draining', () => {
    // Already broken rather than in progress: those accounts' codes cannot be opened,
    // so they are silently sending unstamped mail right now.
    const status = summariseRing(counts([2, 0, 0, 300], [4, 10]), [4], 4);

    expect(status.versions.find((row) => row.version === 2)?.verdict).toBe('orphaned');
    expect(status.orphaned).toContain(2);
  });

  it('keeps the legacy key un-retirable while codes are still sealed under 1 or 2', () => {
    // No factors left on either legacy version — which used to be the whole test — but
    // codes remain on v2. Rotating TOTP_SECRET_KEY here would orphan them.
    const status = summariseRing(counts([1, 0], [2, 0, 0, 12], [4, 10]), [1, 2, 4], 4);

    expect(status.legacyKeyRetirable).toBe(false);
  });

  it('reports anti-phishing rows separately from factors, so the cause is visible', () => {
    const status = summariseRing(counts([2, 3, 1, 12]), [1, 2, 4], 4);
    const v2 = status.versions.find((row) => row.version === 2);

    // Three distinct numbers, not one sum: an operator has to be able to tell which
    // drain they are waiting on — `totp:rotate` for factors, ordinary email traffic for
    // codes.
    expect(v2).toMatchObject({ live: 3, deleted: 1, antiPhishing: 12 });
  });
});

describe('resealFactor', () => {
  const bytes = (value: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(value);

  /** A factor as the backfill's query returns it, sealed under the active version. */
  function enrolled(): {
    id: string;
    userId: string;
    secretCiphertext: Uint8Array<ArrayBuffer>;
    secretIv: Uint8Array<ArrayBuffer>;
    secretTag: Uint8Array<ArrayBuffer>;
    keyVersion: number;
    secret: Buffer;
  } {
    const secret = randomBytes(20);
    const id = '018f0000-0000-7000-8000-00000000000a';
    const userId = '018f0000-0000-7000-8000-00000000000b';
    const sealed = sealSecret(secret, userId, id);
    return {
      id,
      userId,
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
      keyVersion: sealed.keyVersion,
      secret,
    };
  }

  it('produces an envelope that opens to the same secret', () => {
    const factor = enrolled();

    const sealed = resealFactor(factor);

    expect(openFactorSecret({ ...factor, ...toColumns(sealed) })).toEqual(factor.secret);
  });

  it('stamps the active key version', () => {
    expect(resealFactor(enrolled()).keyVersion).toBe(config.totpActiveKeyVersion);
  });

  it('produces a fresh IV, so re-sealing is never a no-op rewrite', () => {
    // GCM reuses of an (key, IV) pair are catastrophic, and a re-seal that kept the IV
    // would encrypt the same plaintext under the same key twice.
    const factor = enrolled();

    const first = resealFactor(factor);
    const second = resealFactor(factor);

    expect(Buffer.from(first.iv)).not.toEqual(Buffer.from(second.iv));
  });

  it('still binds the envelope to its own row', () => {
    const factor = enrolled();
    const sealed = resealFactor(factor);

    // The AAD is (userId, factorId); opening as a different row must fail the tag.
    expect(() =>
      openFactorSecret({
        ...factor,
        ...toColumns(sealed),
        id: '018f0000-0000-7000-8000-0000000000ff',
      }),
    ).toThrow();
  });

  it('refuses a row whose key is not in the ring rather than guessing', () => {
    const factor = enrolled();

    expect(() => resealFactor({ ...factor, keyVersion: 99 })).toThrow(/no TOTP key/i);
  });

  function toColumns(sealed: ReturnType<typeof resealFactor>): {
    secretCiphertext: Uint8Array<ArrayBuffer>;
    secretIv: Uint8Array<ArrayBuffer>;
    secretTag: Uint8Array<ArrayBuffer>;
    keyVersion: number;
  } {
    return {
      secretCiphertext: bytes(Buffer.from(sealed.ciphertext)),
      secretIv: bytes(Buffer.from(sealed.iv)),
      secretTag: bytes(Buffer.from(sealed.tag)),
      keyVersion: sealed.keyVersion,
    };
  }
});
