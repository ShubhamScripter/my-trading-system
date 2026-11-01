/**
 * ═══ THE KEYSET CURSOR FOR KYC HISTORY ═════════════════════════════════════
 *
 * A port of `admin-audit.cursor.ts`, which is this repository's only established
 * convention for paginating an unbounded log. It is copied rather than imported
 * because `src/admin-audits/` is a separate composition — it is not in `app.module.ts`,
 * it serves `/v1/admin/...` rather than a flat prefix, and it is ESM with `.js`
 * specifiers. Importing across that boundary would couple the identity admin surface to
 * the wallet one for forty lines of base64.
 *
 * ─── Why keyset and not OFFSET ─────────────────────────────────────────────
 *
 * KYC history only grows — a row per attempt per level, for ever. `OFFSET n` re-scans
 * the rows it skips, and any row inserted while an operator pages shifts every later
 * page, silently repeating or skipping records. A keyset cursor reads from an index and
 * is stable under concurrent inserts.
 *
 * ─── Why the timestamp carries MICROSECONDS ────────────────────────────────
 *
 * `timestamptz` stores microseconds; a JavaScript `Date` truncates to milliseconds. A
 * cursor built from a truncated value would compare wrongly against the stored one, so
 * the boundary is carried as the exact text Postgres rendered. The id breaks any
 * remaining tie, and `kyc_verifications.id` is uuidv7 — monotonic, so `(created_at, id)`
 * is a total order rather than merely a unique one.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_MICROSECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function invalid(): never {
  throw new Error('INVALID_KYC_HISTORY_CURSOR');
}

/** The exact text form the SQL renders `created_at` in. */
export function isCanonicalKycHistoryTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_MICROSECOND.test(value)) return false;
  // Milliseconds only, for the Date round-trip — the last three digits are microseconds
  // Date cannot represent, and are carried for comparison rather than parsing.
  const parsed = new Date(`${value.slice(0, 23)}Z`);
  return !Number.isNaN(parsed.valueOf());
}

export function encodeKycHistoryCursor(createdAt: string, id: string): string {
  if (!isCanonicalKycHistoryTimestamp(createdAt) || !UUID.test(id)) return invalid();
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

/**
 * Decode, and refuse anything that was not produced by `encode`.
 *
 * ═══ THE RE-ENCODE CHECK IS THE TAMPER GUARD ═══════════════════════════════
 *
 * A cursor is an opaque handle, not an input. Re-encoding the decoded pair and
 * demanding it match the string received rejects padding variants, reordered JSON and
 * anything hand-assembled — so the only cursors that work are ones this service issued.
 * That matters because the pair goes into a WHERE clause: without it, the cursor is a
 * caller-supplied filter wearing a disguise.
 */
export function decodeKycHistoryCursor(cursor: string): readonly [string, string] {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512) invalid();
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    return invalid();
  }

  if (!Array.isArray(parsed) || parsed.length !== 2) invalid();
  const [createdAt, id] = parsed as [unknown, unknown];
  if (typeof createdAt !== 'string' || typeof id !== 'string') invalid();
  if (!isCanonicalKycHistoryTimestamp(createdAt) || !UUID.test(id)) invalid();
  if (encodeKycHistoryCursor(createdAt, id) !== cursor) invalid();

  return [createdAt, id];
}
