import { Logger } from '@nestjs/common';
import type { AntiPhishingColumns } from '../../../auth/persistence/user.dboperation';
import { needsReseal, open, seal, type SealedValue } from '../../utils/sealed-secret';

/**
 * ═══ THE ENVELOPE, AND THE ONE READ THAT MUST NOT THROW ═════════════════════
 *
 * Two jobs: bind the AAD, and give the mail path a reader that degrades instead of
 * failing. Everything here is a pure function of its arguments plus the key ring —
 * no database, no request context.
 */

/** Its own logger, because `antiPhishingCodeOf` is called from `MailService`'s callers
 *  rather than from the service, so there is no instance logger in scope. */
const logger = new Logger('AntiPhishing');

/**
 * What binds an envelope to its account.
 *
 * Order and separator are part of the format: change either and every existing row
 * stops opening. The `v1` label names the AAD FORMAT, and it exists from the first row
 * — unlike TOTP, which had to introduce v2 to add binding to envelopes already in the
 * database, and therefore has to carry both cases forever.
 *
 * ─── Why the account and NOT a row id ───────────────────────────────────────
 *
 * `aadFor` in totp.ts binds `(userId, factorId)` because a user may hold several
 * factors and each envelope belongs to one row. Here the value lives in columns ON the
 * user row, so the account IS the row — there is no second identifier, and inventing
 * one would be a value stored solely to be fed back into the AAD that authenticates it.
 *
 * What this buys is the property that matters: the four columns cannot be copied onto
 * another account's row and opened. The tag check fails, `open` throws, and
 * `antiPhishingCodeOf` reports no code rather than another user's.
 */
export function antiPhishingAad(userId: string): Buffer {
  return Buffer.from(`anti-phishing:v1:${userId}`, 'utf8');
}

/** Seal a code for one account. The plaintext is UTF-8, so the stored length leaks
 *  only the code's byte length — and the alphabet is ASCII, so that is its length. */
export function sealAntiPhishingCode(code: string, userId: string): SealedValue {
  return seal(Buffer.from(code, 'utf8'), antiPhishingAad(userId));
}

/**
 * Open a code for one account. Throws on a bad tag, a wrong key, or an envelope
 * belonging to a different account.
 *
 * Used by the SERVICE, where a throw is the right answer: a `change` that cannot read
 * the current code must not silently proceed as though there were none. The mail path
 * uses `antiPhishingCodeOf` instead.
 */
export function openAntiPhishingCode(sealed: AntiPhishingColumns, userId: string): string {
  return open(sealed, antiPhishingAad(userId)).toString('utf8');
}

/**
 * The account row as the mail path sees it.
 *
 * The four columns plus the id, which is every field `antiPhishingCodeOf` reads — so a
 * caller can hand it a full `User` and the signature still says exactly what is used.
 * Nullable because a caller holding a `User` has not established that a code exists;
 * that is this function's job.
 */
export interface AntiPhishingRow {
  readonly id: string;
  readonly antiPhishingCiphertext: Uint8Array<ArrayBuffer> | null;
  readonly antiPhishingIv: Uint8Array<ArrayBuffer> | null;
  readonly antiPhishingTag: Uint8Array<ArrayBuffer> | null;
  readonly antiPhishingKeyVersion: number | null;
}

/**
 * A row's plaintext code, or `null`.
 *
 * ═══ THIS FUNCTION MUST NEVER THROW, AND THAT IS THE WHOLE DESIGN ═══════════
 *
 * It is called on the path that sends one-time codes, password resets and the
 * email-change recovery link. If it threw, a key-ring misconfiguration or one corrupt
 * row would stop a user receiving the mail that lets them into their account — turning
 * an anti-phishing FEATURE into an authentication outage.
 *
 * So every failure returns `null`, which renders as "no footer", which is exactly what
 * an account with no code configured looks like. The mail still goes.
 *
 * That is a deliberate trade with a real cost: a user whose row cannot be opened
 * silently stops seeing their code, and the honest reading of a missing code is "this
 * might be a forgery". The compensations are that the cause is logged at `error` with
 * the account id, and that `needsReseal` below plus the rotation counter in
 * `summariseRing` are what stop the likeliest cause — a retired key — from happening
 * at all.
 *
 * ─── Why the reseal is fired from HERE ──────────────────────────────────────
 *
 * Because this is the only code path that reads the envelope often. TOTP drains its
 * rotation on the verify path for the same reason: the read that already happens is the
 * cheapest place to migrate a row, and it needs no backfill and no maintenance window.
 *
 * The reseal is UNAWAITED and its result ignored. It must not add latency to a mail
 * send, and every way it can fail is benign — losing a race with a concurrent `change`,
 * or with another reseal, leaves the row on a good key either way. See
 * `UserDbOperation.resealAntiPhishing`, which is predicated on the version this reseal
 * was computed from precisely so the loser writes nothing.
 */
export function antiPhishingCodeOf(
  row: AntiPhishingRow,
  reseal?: (sealed: SealedValue, fromVersion: number) => void,
): string | null {
  const sealed = antiPhishingColumnsOf(row);
  if (sealed === null) return null;

  let code: string;
  try {
    code = openAntiPhishingCode(sealed, row.id);
  } catch (err) {
    // No code in this line — there is none to log, since opening is what failed — and
    // no ciphertext either: it would be a stable per-account identifier in an
    // aggregator for no diagnostic value the key version does not already give.
    logger.error(
      { err, userId: row.id, keyVersion: sealed.keyVersion },
      'could not open the anti-phishing code; sending mail without it',
    );
    return null;
  }

  if (reseal !== undefined && needsReseal(sealed.keyVersion)) {
    // Re-sealed from the PLAINTEXT just recovered rather than by re-encrypting the
    // ciphertext, which is not a thing that can be done. `seal` picks up the active key
    // itself.
    reseal(sealedFor(code, row.id), sealed.keyVersion);
  }

  return code;
}

/** `sealAntiPhishingCode` under a different name, so the reseal above reads as what it
 *  is rather than as a second seal of a new value. */
function sealedFor(code: string, userId: string): SealedValue {
  return sealAntiPhishingCode(code, userId);
}

/**
 * The four columns as an envelope, or `null` when any is absent.
 *
 * They are written and cleared together in one statement, so a partial set is not a
 * state this codebase can produce. Checking all four anyway is what lets the return
 * type be non-nullable per field — the same narrowing `UserDbOperation.findAntiPhishing`
 * performs, repeated here because the mail path holds a `User` rather than the result
 * of that query.
 */
export function antiPhishingColumnsOf(row: AntiPhishingRow): AntiPhishingColumns | null {
  if (
    row.antiPhishingCiphertext === null ||
    row.antiPhishingIv === null ||
    row.antiPhishingTag === null ||
    row.antiPhishingKeyVersion === null
  ) {
    return null;
  }

  return {
    ciphertext: row.antiPhishingCiphertext,
    iv: row.antiPhishingIv,
    tag: row.antiPhishingTag,
    keyVersion: row.antiPhishingKeyVersion,
  };
}

/** Whether a code is configured, without opening it. The status render's whole
 *  question, and it deliberately touches no key material. */
export function hasAntiPhishingCode(row: AntiPhishingRow): boolean {
  return antiPhishingColumnsOf(row) !== null;
}
