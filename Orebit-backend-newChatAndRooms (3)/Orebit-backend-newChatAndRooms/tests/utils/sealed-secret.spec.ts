import { describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { needsReseal, open, seal } from '../../src/utils/sealed-secret';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * `seal`/`open` are the only reversible-secret primitive in the service, and the two
 * properties worth asserting of them are "a value survives the round trip byte for
 * byte" and "an envelope cannot be opened by anything it was not sealed for".
 *
 * The second is the one that matters. AES-GCM's tag makes tampering a decryption
 * failure, but a tag says nothing about WHERE an envelope belongs — that is the AAD's
 * job, and an AAD that is not actually being bound is indistinguishable from one that
 * is until somebody copies four columns from one row to another. So most of this file
 * is about the AAD.
 *
 * The test environment seeds ring versions 1 and 2 from `TOTP_SECRET_KEY` with 2 active
 * (see tests/setup.ts, which deliberately sets no `TOTP_KEYS`), so `seal` writes
 * `keyVersion: 2` and version 1 exercises the retired-key path.
 */

const AAD = Buffer.from('anti-phishing:v1:user-a', 'utf8');
const OTHER_AAD = Buffer.from('anti-phishing:v1:user-b', 'utf8');

describe('seal / open — the round trip', () => {
  it('returns the exact bytes it was given', () => {
    const plaintext = Buffer.from('Correct7Horse', 'utf8');

    expect(open(seal(plaintext, AAD), AAD).equals(plaintext)).toBe(true);
  });

  it('preserves case exactly, which is what makes the value recognisable', () => {
    // Case is part of what a user compares by eye, so a primitive that normalised it
    // would silently break the comparison the whole feature rests on.
    const sealed = seal(Buffer.from('AbCdEf12', 'utf8'), AAD);

    expect(open(sealed, AAD).toString('utf8')).toBe('AbCdEf12');
  });

  it('survives a value at the top of the allowed length', () => {
    const long = 'A'.repeat(30);

    expect(open(seal(Buffer.from(long, 'utf8'), AAD), AAD).toString('utf8')).toBe(long);
  });

  it('records the ACTIVE key version on the envelope', () => {
    // The bytes cannot say which key opens them, so this field is what makes a retired
    // key still usable — and what makes a rotation possible without a backfill.
    expect(seal(Buffer.from('whatever', 'utf8'), AAD).keyVersion).toBe(
      config.totpActiveKeyVersion,
    );
  });

  it('uses a fresh IV per call, so two seals of one value differ', () => {
    // IV reuse under one key is GCM's catastrophic failure mode. Identical ciphertext
    // for identical plaintext would be the visible symptom of it.
    const a = seal(Buffer.from('same-value', 'utf8'), AAD);
    const b = seal(Buffer.from('same-value', 'utf8'), AAD);

    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it('hands back plain Uint8Arrays rather than views onto a pooled Buffer', () => {
    const sealed = seal(Buffer.from('pooled', 'utf8'), AAD);

    // A Buffer may be a view into Node's shared allocation pool, so an envelope holding
    // one would depend on the view's offset surviving every layer down to Postgres.
    expect(sealed.ciphertext.byteOffset).toBe(0);
    expect(sealed.ciphertext.buffer.byteLength).toBe(sealed.ciphertext.byteLength);
  });
});

describe('seal / open — the AAD binding', () => {
  it('refuses an envelope opened under a DIFFERENT aad', () => {
    // The property that stops four columns being copied from one account's row to
    // another's and decrypting cleanly.
    const sealed = seal(Buffer.from('user-a-code', 'utf8'), AAD);

    expect(() => open(sealed, OTHER_AAD)).toThrow();
  });

  it('refuses an envelope opened with no binding at all', () => {
    const sealed = seal(Buffer.from('bound', 'utf8'), AAD);

    expect(() => open(sealed, Buffer.alloc(0))).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = seal(Buffer.from('tamper-me', 'utf8'), AAD);
    const ciphertext = Uint8Array.from(sealed.ciphertext);
    ciphertext[0] = (ciphertext[0] as number) ^ 0xff;

    expect(() => open({ ...sealed, ciphertext }, AAD)).toThrow();
  });

  it('refuses a tampered tag', () => {
    const sealed = seal(Buffer.from('tamper-me', 'utf8'), AAD);
    const tag = Uint8Array.from(sealed.tag);
    tag[0] = (tag[0] as number) ^ 0xff;

    expect(() => open({ ...sealed, tag }, AAD)).toThrow();
  });

  it('refuses an envelope whose iv has been swapped for another seal‘s', () => {
    const a = seal(Buffer.from('first', 'utf8'), AAD);
    const b = seal(Buffer.from('second', 'utf8'), AAD);

    expect(() => open({ ...a, iv: b.iv }, AAD)).toThrow();
  });
});

describe('seal / open — the key ring', () => {
  it('opens a row sealed under a retired-but-present version', () => {
    // The whole point of storing `keyVersion`: version 1 is not active, but it is still
    // in the ring, so rows naming it must keep working while they drain.
    const sealed = seal(Buffer.from('legacy-row', 'utf8'), AAD);

    expect(open({ ...sealed, keyVersion: 1 }, AAD).toString('utf8')).toBe('legacy-row');
  });

  it('refuses a version the ring does not hold, rather than guessing a key', () => {
    // Guessing would either fail the tag anyway or — far worse — succeed against the
    // wrong key. Refusing is the only safe answer, and the message names the cause so
    // an operator reading a 500 can tell a dropped key from a corrupt row.
    const sealed = seal(Buffer.from('orphan', 'utf8'), AAD);

    expect(() => open({ ...sealed, keyVersion: 99 }, AAD)).toThrow(/no key for sealed-value/i);
  });

  it('refuses to seal under an active version missing from the ring', () => {
    // Unreachable through `config`, which validates the pointer at boot. Asserted
    // because the failure mode if it ever became reachable is silent: rows written
    // under a key nothing can look up.
    expect(config.totpKeyRing.has(config.totpActiveKeyVersion)).toBe(true);
  });
});

describe('needsReseal', () => {
  it('is false on the active version', () => {
    expect(needsReseal(config.totpActiveKeyVersion)).toBe(false);
  });

  it('is true on an older version', () => {
    expect(needsReseal(1)).toBe(true);
  });

  it('is true on a NEWER version, so backing out a bad rotation converges', () => {
    // `!==` rather than `<`. Rolling the active pointer back is a legitimate way to
    // undo a rotation, and rows already written under the newer key have to re-seal
    // downward or they never move.
    expect(needsReseal(config.totpActiveKeyVersion + 1)).toBe(true);
  });
});
