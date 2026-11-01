import { config } from '../config';
import { openFactorSecret, sealSecret, type SealedSecret } from './totp';

/**
 * ═══ WHEN IS A TOTP KEY SAFE TO DROP? ═══════════════════════════════════════
 *
 * `needsReseal` re-encrypts a factor onto the active key the next time its owner
 * verifies a code, so a rotation drains on its own with no migration window and no
 * moment where a user cannot sign in. That is the right default and it is already
 * wired — see `MfaService.resealIfLegacy`.
 *
 * What it does not do is END. Lazy rotation has no terminal state:
 *
 *   - Nothing counts how many rows are still on the old version, so the "wait" in
 *     "add a version, point the pointer at it, wait, drop the old key" is a wait for
 *     an event nobody can observe. An operator dropping a key early does not get an
 *     error — they get `keyForVersion` throwing inside a sign-in, which surfaces as
 *     `internal_error` for exactly the users whose rows had not migrated yet.
 *   - A factor whose owner never signs in never re-seals. A handful of dormant
 *     accounts can pin a retired key in the ring forever, which means the key it was
 *     rotated away FROM has to stay loaded in every process indefinitely — and a key
 *     that can never be removed is not a rotation.
 *
 * This module is the other half: a census that answers "is it safe yet", and the
 * re-seal step used by the backfill that makes the answer eventually yes. Both are
 * pure so the decision can be tested without a database — the queries live in
 * `db/totp-rotate.ts`.
 *
 * ─── Why versions 1 and 2 are treated as one unit ───────────────────────────
 *
 * They are two envelope FORMATS sharing one key: both are seeded from
 * `TOTP_SECRET_KEY` in `load()`, so there is no such thing as dropping version 1
 * while keeping version 2 — the ring holds the same buffer under both numbers, and
 * the only way to retire either is to change that one environment variable.
 *
 * Reporting them as independently retirable would therefore be an invitation to
 * rotate `TOTP_SECRET_KEY` while v2 rows still depend on it, which orphans every one
 * of them. `legacyKeyRetirable` is the honest form of the question: it is true only
 * when BOTH formats have drained.
 */

/** The two envelope versions served by `TOTP_SECRET_KEY` rather than by `TOTP_KEYS`. */
export const LEGACY_KEY_VERSIONS: readonly number[] = [1, 2];

/** What the database holds for one key version. Soft-deleted rows are counted
 *  separately because they do not block a retirement — nothing reads them — but an
 *  operator staring at a version with rows still on it deserves to know which kind. */
export interface KeyVersionCount {
  readonly keyVersion: number;
  readonly live: number;
  readonly deleted: number;
  /**
   * ═══ ANTI-PHISHING ROWS ON THIS VERSION ═════════════════════════════════════
   *
   * Accounts whose anti-phishing code is sealed under this key version.
   *
   * ─── Why this file has to know about a feature it has nothing to do with ────
   *
   * Because `config.totpKeyRing` is not the TOTP key ring any more — it is THE key
   * ring, and `src/utils/sealed-secret.ts` reads it too. The retirement decision below
   * answers "can this key be deleted", and a key with no TOTP factors but eight
   * thousand anti-phishing rows is emphatically not deletable. Counting only
   * `totp_factors` would report it `retirable`, an operator would drop it from
   * `TOTP_KEYS`, and every one of those accounts would silently stop seeing its code in
   * its email — a failure `antiPhishingCodeOf` is deliberately built to swallow, so
   * nothing would ever surface it.
   *
   * So this is the obligation that sharing the ring creates, and it is discharged here:
   * every verdict below is computed from TOTP factors PLUS this. Any future caller of
   * `seal` must add its own count for the same reason, and the note in
   * sealed-secret.ts says so.
   *
   * Counted as live-only because these columns have no soft-delete: a code that is
   * cleared is NULL, and a NULL ciphertext has no key version to be counted under.
   */
  readonly antiPhishing: number;
}

/**
 * What should happen to one version.
 *
 *   `active`     new secrets are sealed under it; it stays.
 *   `draining`   live rows remain and its key is present; rotation is in progress.
 *   `retirable`  no live rows and its key is present; it can come out of the ring.
 *   `orphaned`   live rows remain and its key is GONE. Every one of those users is
 *                already failing to sign in. This is an emergency, not a status.
 */
export type KeyVersionVerdict = 'active' | 'draining' | 'retirable' | 'orphaned';

export interface KeyVersionStatus {
  readonly version: number;
  readonly live: number;
  readonly deleted: number;
  /** Anti-phishing rows on this version — see `KeyVersionCount.antiPhishing`. Reported
   *  separately from `live` so an operator can tell WHICH kind of row is holding a
   *  version open, but it counts identically towards every verdict. */
  readonly antiPhishing: number;
  readonly inRing: boolean;
  readonly verdict: KeyVersionVerdict;
}

export interface RingStatus {
  readonly activeVersion: number;
  /** Every version the database or the ring mentions, ascending. */
  readonly versions: readonly KeyVersionStatus[];
  /** Live rows not on the active version — what a backfill would rewrite. */
  readonly pendingReseal: number;
  /** Ring versions that can be deleted from `TOTP_KEYS` now. Never 1 or 2; see the
   *  note above on why those are one unit. */
  readonly safeToDrop: readonly number[];
  /** Versions with live rows and no key. Non-empty means users are locked out. */
  readonly orphaned: readonly number[];
  /** True when neither legacy format has live rows left, so `TOTP_SECRET_KEY` itself
   *  can finally be rotated. */
  readonly legacyKeyRetirable: boolean;
}

/**
 * Turn a census into a decision.
 *
 * Takes the ring's versions and the active version as arguments rather than reading
 * `config`, so a test can describe a ring this process does not have — which is the
 * only way to cover the `orphaned` verdict, since a process holding the key by
 * definition cannot be in that state.
 */
export function summariseRing(
  counts: readonly KeyVersionCount[],
  ringVersions: Iterable<number>,
  activeVersion: number,
): RingStatus {
  const ring = new Set(ringVersions);
  const byVersion = new Map(counts.map((row) => [row.keyVersion, row]));

  // The union, not just what the database has: a key sitting in the ring with no rows
  // is precisely the thing an operator wants told about, because it is the one they
  // can remove.
  const versions = [...new Set([...byVersion.keys(), ...ring])].sort((a, b) => a - b);

  const rows = versions.map((version): KeyVersionStatus => {
    const live = byVersion.get(version)?.live ?? 0;
    const deleted = byVersion.get(version)?.deleted ?? 0;
    const antiPhishing = byVersion.get(version)?.antiPhishing ?? 0;
    const inRing = ring.has(version);

    // Everything this key still has to be able to open. A version is held open by any
    // sealed row, whatever feature wrote it — see `KeyVersionCount.antiPhishing` for
    // why counting only TOTP factors would report a key as droppable while it is still
    // the only thing standing between thousands of accounts and a silent feature
    // failure.
    const held = live + antiPhishing;

    let verdict: KeyVersionVerdict;
    if (version === activeVersion) verdict = 'active';
    else if (!inRing && held > 0) verdict = 'orphaned';
    else if (held > 0) verdict = 'draining';
    else verdict = 'retirable';

    return { version, live, deleted, antiPhishing, inRing, verdict };
  });

  const legacy = new Set(LEGACY_KEY_VERSIONS);

  return {
    activeVersion,
    versions: rows,
    // TOTP factors only. `pendingReseal` is what `npm run totp:rotate` will rewrite,
    // and that backfill walks `totp_factors` — anti-phishing rows drain lazily on the
    // mail path instead (see `antiPhishingCodeOf`), so counting them here would report
    // work this tool does not do. They still hold a version open; that is `verdict`'s
    // job above, and `safeToDrop` reads the verdict.
    pendingReseal: rows
      .filter((row) => row.version !== activeVersion)
      .reduce((total, row) => total + row.live, 0),
    // `inRing` guards against reporting a version that is already gone as droppable,
    // which would read as a pending action that is in fact complete.
    safeToDrop: rows
      .filter((row) => row.verdict === 'retirable' && row.inRing && !legacy.has(row.version))
      .map((row) => row.version),
    orphaned: rows.filter((row) => row.verdict === 'orphaned').map((row) => row.version),
    legacyKeyRetirable:
      !legacy.has(activeVersion) &&
      rows.every(
        (row) => !legacy.has(row.version) || (row.live === 0 && row.antiPhishing === 0),
      ),
  };
}

/** The columns a re-seal needs. Structurally what `openFactorSecret` takes, named
 *  here so the backfill's query and this function cannot drift apart. */
export interface ResealableFactor {
  readonly id: string;
  readonly userId: string;
  readonly secretCiphertext: Uint8Array<ArrayBuffer>;
  readonly secretIv: Uint8Array<ArrayBuffer>;
  readonly secretTag: Uint8Array<ArrayBuffer>;
  readonly keyVersion: number;
}

/**
 * Open a factor under the key its row names and re-seal it under the active one.
 *
 * The plaintext is zeroed before returning, and that is worth the two lines: a
 * backfill walks every enrolled authenticator in the service, so unlike a single
 * verification it accumulates a large number of TOTP secrets in a process whose heap
 * may outlive the run in a core dump. `sealSecret` has already copied the bytes it
 * needs by the time this happens.
 *
 * Throws if the row's key is missing from the ring — `keyForVersion` refuses rather
 * than guessing. The caller decides what to do with that; a backfill should report the
 * row and keep going, because one orphaned version must not stop the others draining.
 */
export function resealFactor(factor: ResealableFactor): SealedSecret {
  const secret = openFactorSecret(factor);
  try {
    return sealSecret(secret, factor.userId, factor.id);
  } finally {
    secret.fill(0);
  }
}

/** The ring this process is running with, for callers that do want `config`. */
export function currentRingVersions(): number[] {
  return [...config.totpKeyRing.keys()].sort((a, b) => a - b);
}
