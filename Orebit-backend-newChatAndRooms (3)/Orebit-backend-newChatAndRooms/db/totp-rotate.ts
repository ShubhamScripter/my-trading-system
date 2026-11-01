/**
 * TOTP key-ring status and backfill.
 *
 *   npm run totp:status              what is on which key, and what can be dropped
 *   npm run totp:rotate -- --dry-run what a backfill would rewrite, writing nothing
 *   npm run totp:rotate              re-seal every live factor onto the active key
 *
 * ─── Why this exists alongside the lazy re-seal ─────────────────────────────
 *
 * `MfaService.resealIfLegacy` migrates a factor the next time its owner verifies a
 * code, which handles the overwhelming majority of rows with no migration window.
 * What it cannot do is finish: a dormant account never verifies, so its row pins the
 * old key in the ring indefinitely. This is the sweep that lets a rotation end —
 * run it once the lazy path has stopped making progress, then drop the key.
 *
 * ─── Safety ─────────────────────────────────────────────────────────────────
 *
 * Every write is the same compare-and-swap the lazy path uses (`keyVersion` in the
 * WHERE), so a row that a user's own sign-in re-sealed a moment earlier is skipped
 * rather than rewritten twice. Rows are re-read each batch rather than paged through
 * a cursor, because a successful re-seal removes a row from the result set on its
 * own — and a cursor over a set that is changing underneath is how a backfill misses
 * rows.
 *
 * A row this process cannot open — its key is not in the ring — is reported and
 * skipped, never deleted. Those users are already unable to sign in, and the fix is
 * to put the key back, not to destroy the only copy of their secret.
 */

import { PrismaClient } from '@prisma/client';
import { config } from '../src/config';
import {
  currentRingVersions,
  resealFactor,
  summariseRing,
  type KeyVersionCount,
  type RingStatus,
} from '../src/2fa/totp.rotation';

const prisma = new PrismaClient();

/** How many factors to open, re-seal and write per round trip. Small enough that a
 *  failure costs little work, large enough that a big table does not take all day. */
const BATCH_SIZE = 200;

/**
 * Count everything sealed under each key version.
 *
 * Two `groupBy` calls over `totp_factors` rather than one over
 * `(keyVersion, deletedAt)`, because `deletedAt` is a timestamp and grouping by it
 * would return one row per DELETION rather than one per version.
 *
 * ─── ⚠ THE THIRD QUERY, AND WHY IT IS NOT OPTIONAL ──────────────────────────
 *
 * `config.totpKeyRing` is shared: `src/utils/sealed-secret.ts` seals the anti-phishing
 * code under the same keys, with its own AAD. So "can this key be dropped" is not a
 * question about `totp_factors` alone, and a census that asked only about them would
 * report a version `retirable` while thousands of accounts still needed it — after
 * which dropping the key would silently stop those users seeing their anti-phishing
 * code, because `antiPhishingCodeOf` is deliberately built to swallow exactly that
 * failure.
 *
 * Hence `users` is counted too, grouped by the same column. Any future caller of `seal`
 * has to be added here for the same reason; the note in sealed-secret.ts says so, and
 * `KeyVersionCount.antiPhishing` explains what the number does to the verdict.
 */
async function census(): Promise<KeyVersionCount[]> {
  const [live, deleted, antiPhishing] = await Promise.all([
    prisma.totpFactor.groupBy({
      by: ['keyVersion'],
      _count: { _all: true },
      where: { deletedAt: null },
    }),
    prisma.totpFactor.groupBy({
      by: ['keyVersion'],
      _count: { _all: true },
      where: { NOT: { deletedAt: null } },
    }),
    // Live accounts only: a soft-deleted user's code is never read, so it cannot hold a
    // key version open. `antiPhishingKeyVersion: { not: null }` is what excludes the
    // overwhelming majority of rows, which have no code configured at all.
    prisma.user.groupBy({
      by: ['antiPhishingKeyVersion'],
      _count: { _all: true },
      where: { deletedAt: null, antiPhishingKeyVersion: { not: null } },
    }),
  ]);

  type Bucket = { live: number; deleted: number; antiPhishing: number };
  const counts = new Map<number, Bucket>();
  const bucket = (version: number): Bucket => {
    const existing = counts.get(version);
    if (existing !== undefined) return existing;
    const fresh = { live: 0, deleted: 0, antiPhishing: 0 };
    counts.set(version, fresh);
    return fresh;
  };

  for (const row of live) bucket(row.keyVersion).live = row._count._all;
  for (const row of deleted) bucket(row.keyVersion).deleted = row._count._all;
  for (const row of antiPhishing) {
    // Non-null by the `where` above; Prisma types the grouped column as nullable
    // because the column is.
    if (row.antiPhishingKeyVersion === null) continue;
    bucket(row.antiPhishingKeyVersion).antiPhishing = row._count._all;
  }

  return [...counts.entries()]
    .map(([keyVersion, all]) => ({ keyVersion, ...all }))
    .sort((a, b) => a.keyVersion - b.keyVersion);
}

function report(status: RingStatus): void {
  console.log(`\nactive envelope version: ${status.activeVersion}`);
  console.log(`ring versions available:  ${currentRingVersions().join(', ') || '(none)'}\n`);

  // `anti-phish` is its own column rather than folded into `live`, so an operator
  // reading a `draining` verdict can see WHICH rows are holding the version open — and
  // therefore which drain to wait for: `totp:rotate` for factors, ordinary email
  // traffic for anti-phishing codes.
  console.log('  version   live   deleted  anti-phish   key      verdict');
  console.log('  ------- ------ --------- ----------- -------- ----------');
  for (const row of status.versions) {
    console.log(
      `  ${String(row.version).padStart(7)} ${String(row.live).padStart(6)} ` +
        `${String(row.deleted).padStart(9)} ${String(row.antiPhishing).padStart(11)} ` +
        `${(row.inRing ? 'present' : 'MISSING').padEnd(8)} ` +
        row.verdict,
    );
  }

  console.log(`\nlive factors awaiting re-seal: ${status.pendingReseal}`);

  // Named separately because this tool cannot fix it. Anti-phishing rows re-seal lazily
  // when their owner is next emailed, so the honest instruction is to wait rather than
  // to run a backfill that does not touch them.
  const antiPhishingPending = status.versions
    .filter((row) => row.version !== status.activeVersion)
    .reduce((total, row) => total + row.antiPhishing, 0);
  if (antiPhishingPending > 0) {
    console.log(
      `anti-phishing codes awaiting re-seal: ${antiPhishingPending} ` +
        '(drains lazily as those accounts are emailed; `totp:rotate` does not touch them)',
    );
  }

  if (status.orphaned.length > 0) {
    // First, and loudest: this is the only line here that describes users who are
    // currently unable to sign in.
    console.error(
      `\n!! ORPHANED: version(s) ${status.orphaned.join(', ')} have live factors and no ` +
        'key in the ring.\n' +
        '   Those users cannot verify a TOTP code. Restore the key to TOTP_KEYS and ' +
        're-run.',
    );
  }

  if (status.safeToDrop.length > 0) {
    console.log(
      `\nsafe to remove from TOTP_KEYS now: ${status.safeToDrop.join(', ')} ` +
        '(no live factors remain on them)',
    );
  }

  if (status.legacyKeyRetirable) {
    console.log(
      '\nboth legacy envelope versions (1 and 2) have drained, so TOTP_SECRET_KEY no ' +
        'longer opens any live factor and can be rotated.',
    );
  } else if (status.activeVersion > 2) {
    console.log(
      '\nTOTP_SECRET_KEY is still required: versions 1 and 2 share it, and at least one ' +
        'still has live factors.',
    );
  }
}

/**
 * Re-seal every live factor that is not on the active version.
 *
 * Loops until a batch makes no progress rather than until the query is empty: a row
 * that cannot be opened stays in the result set forever, so "empty" is not a
 * termination condition an unopenable row would ever satisfy.
 */
async function backfill(dryRun: boolean): Promise<void> {
  let resealed = 0;
  let skipped = 0;
  const failures = new Map<number, number>();

  for (;;) {
    const batch = await prisma.totpFactor.findMany({
      where: { deletedAt: null, keyVersion: { not: config.totpActiveKeyVersion } },
      select: {
        id: true,
        userId: true,
        secretCiphertext: true,
        secretIv: true,
        secretTag: true,
        keyVersion: true,
      },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' },
    });

    if (batch.length === 0) break;

    let progressed = 0;

    for (const factor of batch) {
      if (dryRun) {
        progressed += 1;
        resealed += 1;
        continue;
      }

      let sealed: ReturnType<typeof resealFactor>;
      try {
        sealed = resealFactor(factor);
      } catch {
        // Almost always a version whose key is not loaded. Counted per version so the
        // summary names the key to restore rather than listing a thousand row ids.
        failures.set(factor.keyVersion, (failures.get(factor.keyVersion) ?? 0) + 1);
        continue;
      }

      const written = await prisma.totpFactor.updateMany({
        where: { id: factor.id, keyVersion: factor.keyVersion, deletedAt: null },
        data: {
          secretCiphertext: sealed.ciphertext,
          secretIv: sealed.iv,
          secretTag: sealed.tag,
          keyVersion: sealed.keyVersion,
        },
      });

      progressed += 1;
      // Zero rows means the owner signed in and the lazy path re-sealed it between
      // our read and our write. That is the CAS working, not an error.
      if (written.count === 1) resealed += 1;
      else skipped += 1;
    }

    // A dry run never writes, so the same rows would come back forever.
    if (dryRun || progressed === 0) break;
  }

  if (dryRun) {
    console.log(`\ndry run: ${resealed} live factor(s) would be re-sealed. Nothing written.`);
    return;
  }

  console.log(`\nre-sealed ${resealed} factor(s); ${skipped} already moved by a sign-in.`);

  if (failures.size > 0) {
    const detail = [...failures.entries()]
      .map(([version, count]) => `v${version}: ${count}`)
      .join(', ');
    console.error(
      `\n!! could not open ${detail}. Those rows were left untouched — add the missing ` +
        'key(s) to TOTP_KEYS and re-run.',
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status');
  const dryRun = args.includes('--dry-run');

  const status = summariseRing(
    await census(),
    config.totpKeyRing.keys(),
    config.totpActiveKeyVersion,
  );
  report(status);

  if (statusOnly) return;

  if (status.pendingReseal === 0) {
    console.log('\nnothing to re-seal.');
    return;
  }

  await backfill(dryRun);

  if (!dryRun) {
    report(
      summariseRing(await census(), config.totpKeyRing.keys(), config.totpActiveKeyVersion),
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
