import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config';

/**
 * ═══ AES-256-GCM AT REST, FOR VALUES THAT MUST BE READ BACK ═════════════════
 *
 * The generic half of what `src/2fa/totp.ts` does to a TOTP secret. Two functions,
 * no domain knowledge: a caller supplies the plaintext and the AAD, and gets back
 * four values to store on a row.
 *
 * ─── When to reach for this, and when NOT to ────────────────────────────────
 *
 * Almost never. Every secret in this schema that CAN be hashed is hashed —
 * `CredentialService.hash` for a low-entropy user-chosen value, `pepperedHash` for a
 * high-entropy server-minted one — because a hash cannot be read back out of a stolen
 * dump at all. This file exists only for the narrow case where the product needs the
 * ORIGINAL value later: a TOTP secret, because verifying a code means regenerating it,
 * and an anti-phishing code, because the whole point is to print it in an email.
 *
 * A new caller here should be able to say why a hash cannot work. If it can, use one.
 *
 * ─── Why this is a new file rather than an export from totp.ts ──────────────
 *
 * `sealSecret`/`openSecret` there are not generic and should not be made generic:
 * their AAD is hardcoded to `totp:v2:${userId}:${factorId}`, which binds an envelope
 * to a factor ROW — a shape no other caller has — and that file warns explicitly that
 * its version field "must never grow a THIRD format". Widening it would put every
 * enrolled authenticator behind a refactor for the benefit of an unrelated feature.
 *
 * So the construction is duplicated and the KEY MATERIAL is shared. That is the right
 * way round: two independent implementations of AES-GCM would be two places to get a
 * nonce wrong, whereas two AAD labels over one ring is ordinary domain separation.
 *
 * ─── ⚠ THE KEY RING IS SHARED WITH TOTP, AND THAT HAS A CONSEQUENCE ─────────
 *
 * `config.totpKeyRing` is the only 32-byte key ring this service has, and it is read
 * here as well as by `src/2fa/totp.ts`. Domain separation comes from the AAD, so a
 * TOTP envelope can never open as something else and vice versa — the tag check
 * fails. Sharing the ring is safe cryptographically.
 *
 * What it is not is safe OPERATIONALLY unless every caller is visible to the rotation
 * procedure. `totp.ts` documents that procedure as: add a key, point
 * `TOTP_ACTIVE_KEY_VERSION` at it, let `needsReseal` drain the old one, "and once none
 * are left on the old version, drop it from the ring." An operator answers "none are
 * left" from `npx tsx db/totp-rotate.ts --status`, so anything sealed through THIS file
 * has to be counted there too, or a version reads as drainable while rows still name
 * it and dropping the key destroys them.
 *
 * `summariseRing` in src/2fa/totp.rotation.ts therefore counts every sealed column
 * family, not just `totp_factors`. A future caller of this file MUST add itself to
 * that count. That is the whole cost of sharing the ring, and it is written here
 * because this is the file a new caller reads.
 */

/**
 * One sealed value, as four columns.
 *
 * `Uint8Array` rather than `Buffer` for `SealedSecret`'s reason: these go straight
 * into `Bytes` columns, which Prisma types as `Uint8Array<ArrayBuffer>`, so the
 * conversion happens once here instead of at every call site.
 */
export interface SealedValue {
  readonly ciphertext: Uint8Array<ArrayBuffer>;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly tag: Uint8Array<ArrayBuffer>;
  /** Which key sealed it. Stored on the row, because the bytes cannot say. */
  readonly keyVersion: number;
}

/**
 * The key for one version, or a refusal.
 *
 * A retired key stays reachable for as long as rows still name its version, which is
 * why this selects by the ROW's label rather than assuming the active key opened
 * everything. Refusing beats guessing: a wrong key either fails the tag anyway or, far
 * worse, succeeds against something it should not.
 */
function keyForVersion(version: number): Buffer {
  const key = config.totpKeyRing.get(version);
  if (key === undefined) {
    throw new Error(`no key for sealed-value envelope version ${version}`);
  }
  return key;
}

/**
 * Seal `plaintext` under the active key, bound to `aad`.
 *
 * A fresh 12-byte IV per call, and no code path accepts one from a caller — IV reuse
 * under a single key is GCM's catastrophic failure mode, so the only way to be sure it
 * cannot happen is for the caller to be unable to influence it. Same reasoning as the
 * note above `SealedSecret` in totp.ts.
 *
 * `aad` is REQUIRED rather than optional. An unbound envelope is one whose columns can
 * be copied from one row to another — or to another account's row — and will decrypt
 * cleanly into a working value. That is the exact defect TOTP envelope v2 was
 * introduced to fix, and a signature that cannot be called without an AAD is what
 * stops it being reintroduced here.
 */
export function seal(plaintext: Buffer, aad: Buffer): SealedValue {
  // Read per call rather than captured at module load. `config` is frozen at boot so
  // this cannot change under a running process today, but capturing it would make a
  // future reload keep sealing under a retired key — the one failure a rotation
  // mechanism must not have.
  const version = config.totpActiveKeyVersion;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyForVersion(version), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // Copied into plain Uint8Arrays rather than handed over as Buffers, for the reason
  // `sealSecret` gives: a Buffer may be a VIEW onto Node's shared allocation pool, so
  // the bytes a `Bytes` column receives would depend on the view's offset surviving
  // every layer in between. Copying makes the envelope self-contained.
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    tag: new Uint8Array(cipher.getAuthTag()),
    keyVersion: version,
  };
}

/**
 * Open a sealed value, or throw.
 *
 * Throws on a bad tag, a wrong key, or an envelope that does not belong to the row it
 * was loaded from. It throws rather than returning null because those three causes are
 * indistinguishable from the bytes and every one of them means the database and the key
 * ring disagree — an operational problem, not a wrong-value answer.
 *
 * Callers on a path that must not fail because of it are expected to catch and degrade;
 * see `antiPhishingCodeOf`, which turns this into "no footer" rather than a failed
 * security email.
 */
export function open(sealed: SealedValue, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', keyForVersion(sealed.keyVersion), sealed.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

/**
 * True when this row is not on the active key and should be re-sealed when convenient.
 *
 * `!==` rather than `<`, for `needsReseal`'s reason in totp.ts: rolling the pointer BACK
 * is a legitimate way to back out a bad rotation, and rows written under the newer key
 * have to re-seal downward for that to converge.
 */
export function needsReseal(keyVersion: number): boolean {
  return keyVersion !== config.totpActiveKeyVersion;
}
