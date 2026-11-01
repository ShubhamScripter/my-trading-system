import { describe, expect, it, vi } from 'vitest';
import { config } from '../../../src/config';
import {
  antiPhishingAad,
  antiPhishingCodeOf,
  antiPhishingColumnsOf,
  hasAntiPhishingCode,
  openAntiPhishingCode,
  sealAntiPhishingCode,
} from '../../../src/settings/antiPhishing/antiPhishing.utility';
import { makeUser } from '../../harness';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * Two properties, and they pull in opposite directions.
 *
 * The SERVICE must not proceed on a code it could not read — a `change` that silently
 * treated an unreadable envelope as "no code" would compare against nothing. So
 * `openAntiPhishingCode` throws.
 *
 * The MAIL PATH must never fail because of this feature. It sends one-time codes,
 * password resets and the email-change recovery link, so a key-ring misconfiguration
 * that threw here would stop a user receiving the message that lets them back into
 * their account — turning an anti-phishing feature into an authentication outage. So
 * `antiPhishingCodeOf` returns `null` for every failure.
 *
 * Most of this file is about that second guarantee, because it is the one whose
 * violation is catastrophic and whose correctness is invisible in normal operation.
 */

const CODE = 'Ada1815';

/** A user row with a code sealed for that row's own id. */
function withCode(code = CODE, overrides: Parameters<typeof makeUser>[0] = {}) {
  const user = makeUser(overrides);
  const sealed = sealAntiPhishingCode(code, user.id);
  return {
    ...user,
    antiPhishingCiphertext: sealed.ciphertext,
    antiPhishingIv: sealed.iv,
    antiPhishingTag: sealed.tag,
    antiPhishingKeyVersion: sealed.keyVersion,
    antiPhishingSetAt: new Date(),
  };
}

describe('antiPhishingAad', () => {
  it('binds to the account and nothing else', () => {
    expect(antiPhishingAad('user-a').toString('utf8')).toBe('anti-phishing:v1:user-a');
  });

  it('differs per account, which is what makes the binding meaningful', () => {
    expect(antiPhishingAad('user-a').equals(antiPhishingAad('user-b'))).toBe(false);
  });
});

describe('seal / open a code', () => {
  it('round-trips the exact code', () => {
    const sealed = sealAntiPhishingCode(CODE, 'user-a');

    expect(openAntiPhishingCode(sealed, 'user-a')).toBe(CODE);
  });

  it('preserves case', () => {
    const sealed = sealAntiPhishingCode('AbCd1234', 'user-a');

    expect(openAntiPhishingCode(sealed, 'user-a')).toBe('AbCd1234');
  });

  it('THROWS when opened for a different account', () => {
    // ═══ THE PROPERTY THE AAD EXISTS FOR ════════════════════════════════════
    //
    // Copying the four columns from one account's row onto another's must not yield a
    // working code. Without the binding the tag would still verify — it authenticates
    // the ciphertext, not its location — and the second account would silently display
    // the first one's code.
    const sealed = sealAntiPhishingCode(CODE, 'user-a');

    expect(() => openAntiPhishingCode(sealed, 'user-b')).toThrow();
  });
});

describe('antiPhishingColumnsOf', () => {
  it('is null when no code is configured', () => {
    expect(antiPhishingColumnsOf(makeUser())).toBeNull();
  });

  it('maps the four columns onto an envelope when all are present', () => {
    const row = withCode();

    expect(antiPhishingColumnsOf(row)).toEqual({
      ciphertext: row.antiPhishingCiphertext,
      iv: row.antiPhishingIv,
      tag: row.antiPhishingTag,
      keyVersion: row.antiPhishingKeyVersion,
    });
  });

  it.each(['antiPhishingCiphertext', 'antiPhishingIv', 'antiPhishingTag', 'antiPhishingKeyVersion'])(
    'is null when %s alone is missing',
    (column) => {
      // Not a state this codebase can produce — the columns are written and cleared in
      // one statement — but the narrowing is what lets every field downstream be
      // non-nullable, so a partial row must not slip through as configured.
      const row = { ...withCode(), [column]: null };

      expect(antiPhishingColumnsOf(row)).toBeNull();
    },
  );
});

describe('hasAntiPhishingCode', () => {
  it('is false with no code', () => {
    expect(hasAntiPhishingCode(makeUser())).toBe(false);
  });

  it('is true with a code, without opening it', () => {
    // The status render's whole question. It touches no key material, so a key problem
    // cannot break the settings screen — and there is no path from the status endpoint
    // to the plaintext for a later change to accidentally expose.
    expect(hasAntiPhishingCode(withCode())).toBe(true);
  });
});

describe('antiPhishingCodeOf — the mail path', () => {
  it('returns the code for a configured account', () => {
    expect(antiPhishingCodeOf(withCode())).toBe(CODE);
  });

  it('returns null for an account with no code', () => {
    expect(antiPhishingCodeOf(makeUser())).toBeNull();
  });

  it('returns null rather than THROWING on a corrupt envelope', () => {
    // ═══ THE GUARANTEE THIS WHOLE FILE IS ABOUT ═════════════════════════════
    //
    // If this threw, one corrupt row would stop that user receiving their sign-in codes
    // and their account-recovery link. `null` degrades to "no footer", which is exactly
    // what an account without a code looks like, and the mail still goes.
    const row = withCode();
    const ciphertext = Uint8Array.from(row.antiPhishingCiphertext);
    ciphertext[0] = (ciphertext[0] as number) ^ 0xff;

    expect(antiPhishingCodeOf({ ...row, antiPhishingCiphertext: ciphertext })).toBeNull();
  });

  it('returns null rather than throwing when the key version is not in the ring', () => {
    // The likeliest real cause: a key retired from `TOTP_KEYS` while rows still named
    // it. `summariseRing` counts these rows precisely to stop that happening, and this
    // is the behaviour if it does anyway.
    const row = { ...withCode(), antiPhishingKeyVersion: 99 };

    expect(antiPhishingCodeOf(row)).toBeNull();
  });

  it('returns null rather than another account‘s code when the row was copied', () => {
    // Envelope sealed for someone else, columns pasted onto this row. The AAD refuses
    // it, and the honest answer on the mail path is "no code" — never a code belonging
    // to a different account, which would be a cross-account disclosure in an email.
    const sealed = sealAntiPhishingCode(CODE, 'a-different-user-entirely');
    const row = {
      ...makeUser(),
      antiPhishingCiphertext: sealed.ciphertext,
      antiPhishingIv: sealed.iv,
      antiPhishingTag: sealed.tag,
      antiPhishingKeyVersion: sealed.keyVersion,
    };

    expect(antiPhishingCodeOf(row)).toBeNull();
  });
});

describe('antiPhishingCodeOf — the lazy reseal', () => {
  it('does not reseal a row already on the active key', () => {
    const reseal = vi.fn();

    antiPhishingCodeOf(withCode(), reseal);

    expect(reseal).not.toHaveBeenCalled();
  });

  it('reseals a row on a retired version, onto the active key', () => {
    // The drain half of rotation, fired from the read that already happens — the same
    // arrangement TOTP uses on its verify path. No backfill, no maintenance window.
    const row = withCode();
    const stale = sealAntiPhishingCode(CODE, row.id);
    const reseal = vi.fn();

    const code = antiPhishingCodeOf(
      { ...row, antiPhishingCiphertext: stale.ciphertext, antiPhishingIv: stale.iv, antiPhishingTag: stale.tag, antiPhishingKeyVersion: 1 },
      reseal,
    );

    expect(code).toBe(CODE);
    expect(reseal).toHaveBeenCalledTimes(1);

    const [sealed, fromVersion] = reseal.mock.calls[0] as [
      { keyVersion: number; ciphertext: Uint8Array<ArrayBuffer> },
      number,
    ];
    // Sealed under the ACTIVE version, and reporting the version it came FROM so the
    // write can be predicated on it — two concurrent reseals must not clobber each
    // other.
    expect(sealed.keyVersion).toBe(config.totpActiveKeyVersion);
    expect(fromVersion).toBe(1);
  });

  it('reseals to an envelope that still opens to the same code', () => {
    const row = withCode();
    const stale = sealAntiPhishingCode(CODE, row.id);
    const reseal = vi.fn();

    antiPhishingCodeOf(
      { ...row, antiPhishingCiphertext: stale.ciphertext, antiPhishingIv: stale.iv, antiPhishingTag: stale.tag, antiPhishingKeyVersion: 1 },
      reseal,
    );

    const [sealed] = reseal.mock.calls[0] as [Parameters<typeof openAntiPhishingCode>[0]];
    expect(openAntiPhishingCode(sealed, row.id)).toBe(CODE);
  });

  it('does not attempt a reseal when the envelope could not be opened', () => {
    // Nothing to re-seal FROM. Calling the callback with a seal of garbage would write
    // a valid-looking envelope over an unreadable one and destroy the evidence.
    const row = { ...withCode(), antiPhishingKeyVersion: 99 };
    const reseal = vi.fn();

    expect(antiPhishingCodeOf(row, reseal)).toBeNull();
    expect(reseal).not.toHaveBeenCalled();
  });

  it('still returns the code when no reseal callback is supplied', () => {
    // Callers that only want to read — the status path and every mail site — pass
    // nothing, and a stale key version must not become their problem.
    const row = withCode();
    const stale = sealAntiPhishingCode(CODE, row.id);

    const code = antiPhishingCodeOf({
      ...row,
      antiPhishingCiphertext: stale.ciphertext,
      antiPhishingIv: stale.iv,
      antiPhishingTag: stale.tag,
      antiPhishingKeyVersion: 1,
    });

    expect(code).toBe(CODE);
  });
});
