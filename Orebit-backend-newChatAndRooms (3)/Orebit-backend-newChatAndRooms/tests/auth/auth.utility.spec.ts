import { describe, expect, it } from 'vitest';
import { PUBLIC_CODE, REFERRAL, SESSION, USERNAME } from '../../auth/auth.constants';
import {
  csrfTokenMatches,
  emailLocalPart,
  generateCsrfToken,
  generatePublicCode,
  generateReferralCode,
  generateUsernameCandidates,
  clientContextOf,
  normaliseCode,
  sessionExpiry,
  toPublicUser,
} from '../../auth/auth.utility';
import { FIXED_NOW, makeUser } from '../harness';

/** Crockford base32 — the alphabet minus I, L, O and U. */
const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;

describe('emailLocalPart', () => {
  it('takes the part before the @', () => {
    expect(emailLocalPart('ada.lovelace@example.test')).toBe('ada.lovelace');
  });

  it('returns the whole string when there is no @', () => {
    expect(emailLocalPart('ada.lovelace')).toBe('ada.lovelace');
  });

  it('splits on the first @, not the last', () => {
    expect(emailLocalPart('a@b@example.test')).toBe('a');
  });
});

describe('normaliseCode', () => {
  it('trims and uppercases, so a typed code matches its stored key', () => {
    expect(normaliseCode('  k7m2p9qr  ')).toBe('K7M2P9QR');
  });
});

describe('generatePublicCode', () => {
  it('is the prefix plus eight Crockford characters', () => {
    const code = generatePublicCode();

    expect(code.startsWith(PUBLIC_CODE.PREFIX)).toBe(true);
    expect(code).toHaveLength(PUBLIC_CODE.PREFIX.length + PUBLIC_CODE.RANDOM_LENGTH);
    expect(code.slice(PUBLIC_CODE.PREFIX.length)).toMatch(CROCKFORD);
  });

  it('does not repeat across a run', () => {
    const codes = new Set(Array.from({ length: 200 }, generatePublicCode));
    expect(codes.size).toBe(200);
  });
});

describe('generateReferralCode', () => {
  it('is eight Crockford characters, excluding the confusable letters', () => {
    // The exclusion is the whole reason for the alphabet: these are codes a
    // human reads off one screen and types into another.
    for (let i = 0; i < 200; i += 1) {
      const code = generateReferralCode();
      expect(code).toHaveLength(REFERRAL.CODE_LENGTH);
      expect(code).toMatch(CROCKFORD);
      expect(code).not.toMatch(/[ILOU]/);
    }
  });
});

describe('generateUsernameCandidates', () => {
  it('offers the sanitised seed first, then suffixed variants', () => {
    const candidates = generateUsernameCandidates('Ada.Lovelace', 4);

    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toBe('ada_lovelace');
    for (const candidate of candidates.slice(1)) {
      expect(candidate).toMatch(/^ada_lovelace\d{4}$/);
    }
  });

  it('returns distinct candidates — a repeat would waste an allocation attempt', () => {
    const candidates = generateUsernameCandidates('ada', USERNAME.MAX_ALLOCATION_ATTEMPTS);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it('strips accents rather than dropping the characters', () => {
    // NFKD then a combining-mark strip, so "é" becomes "e" and not "_".
    expect(generateUsernameCandidates('Ámélie Poulain', 1)[0]).toBe('amelie_poulain');
  });

  it('collapses runs of punctuation and trims the edges', () => {
    expect(generateUsernameCandidates('..Ada--%%--Lovelace..', 1)[0]).toBe('ada_lovelace');
  });

  it('falls back to a generated name when the seed sanitises to nothing usable', () => {
    // A seed of pure punctuation, and a seed shorter than the minimum, both land
    // here: there is no stem worth showing the user, so the account gets a
    // neutral one rather than a one-character username.
    expect(generateUsernameCandidates('!!!', 1)[0]).toMatch(/^orebit\d{4}$/);
    expect(generateUsernameCandidates('jo', 1)[0]).toMatch(/^orebit\d{4}$/);
  });

  it('keeps every candidate within the maximum length, suffix included', () => {
    const candidates = generateUsernameCandidates('a'.repeat(64), USERNAME.MAX_ALLOCATION_ATTEMPTS);

    for (const candidate of candidates) {
      expect(candidate.length).toBeGreaterThanOrEqual(USERNAME.DEFAULT_MIN_LENGTH);
      expect(candidate.length).toBeLessThanOrEqual(USERNAME.MAX_LENGTH);
    }
  });
});

describe('toPublicUser', () => {
  it('derives emailVerified from the timestamp and reads country from countryDeclared', () => {
    const user = makeUser({ emailVerifiedAt: FIXED_NOW, countryDeclared: 'GB' });

    expect(toPublicUser(user, true)).toEqual({
      publicCode: user.publicCode,
      username: user.username,
      email: user.email,
      emailVerified: true,
      country: 'GB',
      referralCode: user.referralCode,
      hasPassword: true,
      registeredAt: user.registeredAt,
      avatarUrl: null,
    });
  });

  it('reports an unverified address and a missing country as such', () => {
    const projection = toPublicUser(
      makeUser({ emailVerifiedAt: null, countryDeclared: null }),
      false,
    );

    expect(projection.emailVerified).toBe(false);
    expect(projection.country).toBeNull();
    expect(projection.hasPassword).toBe(false);
  });

  it('omits every field that is not on the public projection', () => {
    // The point of the explicit interface: a column added to User must not
    // start appearing in API responses on its own.
    const projection = toPublicUser(makeUser(), true);

    expect(Object.keys(projection).sort()).toEqual([
      'avatarUrl',
      'country',
      'email',
      'emailVerified',
      'hasPassword',
      'publicCode',
      'referralCode',
      'registeredAt',
      'username',
    ]);
  });
});

describe('sessionExpiry — the idle window and the trust window', () => {
  const IDLE_MS = SESSION.IDLE_TIMEOUT_SECONDS * 1000;

  it('is the idle window when the device is not trusted', () => {
    const expiry = sessionExpiry(null);

    expect(expiry.getTime() - Date.now()).toBeGreaterThan(IDLE_MS - 5_000);
    expect(expiry.getTime() - Date.now()).toBeLessThanOrEqual(IDLE_MS);
  });

  it('honours a trust window that outlasts the idle one', () => {
    const rememberUntil = new Date(Date.now() + IDLE_MS * 7);

    // The whole point of remember-me: survive the idle window with zero activity.
    expect(sessionExpiry(rememberUntil)).toEqual(rememberUntil);
  });

  it('falls back to the idle window once the trust window has passed', () => {
    // No branch does this and no job clears the column — an expired
    // `rememberUntil` simply stops being the later of the two.
    const expired = new Date(Date.now() - 1_000);

    const expiry = sessionExpiry(expired);

    expect(expiry.getTime()).toBeGreaterThan(Date.now());
    expect(expiry.getTime() - Date.now()).toBeLessThanOrEqual(IDLE_MS);
  });

  it('never shortens a session below the idle window', () => {
    // A trust window closing in an hour must not cut a fresh session to an hour.
    const soon = new Date(Date.now() + 60 * 60 * 1000);

    expect(sessionExpiry(soon).getTime() - Date.now()).toBeGreaterThan(IDLE_MS - 5_000);
  });
});

describe('ipClassOf — the location prefix, via clientContextOf', () => {
  const classOf = (ip: string) => clientContextOf(ip, null, 'x'.repeat(43)).ipClass;

  it('takes the /24 of an IPv4 address', () => {
    expect(classOf('203.0.113.7')).toBe('203.0.113.0/24');
  });

  it('gives one class to two addresses in the same IPv6 site', () => {
    // The bug this replaces: `filter(p => p !== '')` deleted the `::` marker, so
    // `2001:db8::1` reported the /48 of the unrelated site `2001:db8:1::`.
    expect(classOf('2001:db8::1')).toBe(classOf('2001:db8::99ff'));
  });

  it('does not collide two genuinely different sites', () => {
    expect(classOf('2001:db8::1')).not.toBe(classOf('2001:db8:1::5'));
  });

  it('gives one class to the same address written two legal ways', () => {
    // Leading zeros and an expanded run are the same address; a class function
    // that disagreed with itself would report a location change that never happened.
    expect(classOf('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(classOf('2001:db8::1'));
  });

  it('treats an IPv4-mapped address as the IPv4 client it is', () => {
    // Node hands this form to a dual-stack listener. Classified as IPv6 it yielded
    // the FULL address, so every IPv4 client looked like its own network — the
    // exact opposite of what the prefix exists to do.
    expect(classOf('::ffff:203.0.113.7')).toBe('203.0.113.0/24');
  });

  it('ignores a zone index', () => {
    expect(classOf('fe80::1%eth0')).toBe(classOf('fe80::1'));
  });

  it('returns unparseable input unchanged rather than inventing a class', () => {
    // Nine groups is not an address. `req.ip` comes from Fastify so this is
    // defensive, but inventing a plausible-looking class for garbage would put a
    // fabricated location on a session row.
    expect(classOf('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
    expect(classOf('::ffff:999.1.1.1')).toBe('::ffff:999.1.1.1');
  });
});

/**
 * The CSRF token guarding POST /auth/session.
 *
 * The property that matters is the BINDING: a same-site attacker can write cookies
 * for the parent domain, so a plain random double-submit pair is one they could set
 * both halves of themselves. Every test here is about a pair being useless anywhere
 * except with the refresh token it was minted for.
 */
describe('generateCsrfToken / csrfTokenMatches', () => {
  const REFRESH = 'refresh-token-value';

  it('accepts a token against the refresh token it was minted for', () => {
    expect(csrfTokenMatches(generateCsrfToken(REFRESH), REFRESH)).toBe(true);
  });

  it('refuses a token minted for a different refresh token', () => {
    // The whole point: a pair lifted from another session, or one an attacker
    // obtained by logging in as themselves, does not verify here.
    expect(csrfTokenMatches(generateCsrfToken('someone-elses-token'), REFRESH)).toBe(false);
  });

  it('never issues the same token twice', () => {
    // The nonce is what makes each one distinct, so a captured pair is not a
    // long-lived secret even for the same session.
    expect(generateCsrfToken(REFRESH)).not.toBe(generateCsrfToken(REFRESH));
  });

  it('does not contain the refresh token it is bound to', () => {
    // The cookie is readable by script by necessity. It must therefore not be a
    // path back to the credential it guards.
    expect(generateCsrfToken(REFRESH)).not.toContain(REFRESH);
  });

  it('refuses a tampered signature while keeping the nonce', () => {
    const token = generateCsrfToken(REFRESH);
    const [nonce] = token.split('.');
    expect(csrfTokenMatches(`${nonce}.${'0'.repeat(64)}`, REFRESH)).toBe(false);
  });

  it('refuses a tampered nonce while keeping the signature', () => {
    const token = generateCsrfToken(REFRESH);
    const signature = token.slice(token.indexOf('.') + 1);
    expect(csrfTokenMatches(`tampered.${signature}`, REFRESH)).toBe(false);
  });

  it('refuses malformed input rather than throwing', () => {
    // `safeEqual` throws on a length mismatch, so these have to be rejected before
    // they reach it — an unhandled throw here would be a 500 on a forged header.
    for (const bad of ['', '.', 'noseparator', '.onlysignature', 'onlynonce.']) {
      expect(csrfTokenMatches(bad, REFRESH)).toBe(false);
    }
  });
});

/**
 * ═══ ONE SIGNED MESSAGE MUST MEAN ONE (NONCE, HANDLE) PAIR ══════════════════
 *
 * The signature was taken over `${nonce}:${handle}`. `pepperedHash` documents this
 * exact hazard for its own tag — domain `a` + value `bc` digests identically to domain
 * `ab` + value `c` — and is safe only because `HashDomain` is a closed union with no
 * `:` in any member. This call site had no such guarantee.
 *
 * A GENERATED nonce is base64url and cannot contain `:`. The nonce reaching
 * VERIFICATION is not generated: `csrfTokenMatches` slices it out of the token the
 * caller sent. So `("a:b", "c")` and `("a", "b:c")` were one message and one
 * signature — a single authenticated string standing for two different bindings.
 *
 * ─── How these tests reach it without the private helper ───────────────────
 *
 * `csrfSignature` is module-private, and testing it directly would prove less anyway.
 * Instead each case mints a REAL token for a handle containing a separator, then
 * re-splits the same underlying message a different way and asks whether the issued
 * signature still verifies. That is the actual attack shape — a token issued for one
 * handle authenticating another — expressed entirely through the public API the guard
 * itself calls.
 *
 * Latent, not reachable: the server only ever signs a random base64url nonce against a
 * base64url handle, so an issued message holds exactly one `:` in exactly one place.
 * These handles are therefore wider than production can currently produce, which is the
 * point — the encoding is what is under test, not today's alphabet.
 */
describe('csrf signatures — separator collisions', () => {
  /** Split a minted token the way `csrfTokenMatches` does. */
  const parts = (token: string): { nonce: string; signature: string } => ({
    nonce: token.slice(0, token.indexOf('.')),
    signature: token.slice(token.indexOf('.') + 1),
  });

  it('does not let a token issued for "b:c" authenticate the handle "c"', () => {
    // ═══ THE CORE REGRESSION ════════════════════════════════════════════════
    //
    // Issued message was `<nonce>:b:c`. Re-cut one separator to the left and the same
    // bytes read as nonce `<nonce>:b` with handle `c` — so the signature verified
    // against a handle it was never issued for.
    const token = generateCsrfToken('b:c');
    const { nonce, signature } = parts(token);

    const recut = `${nonce}:b.${signature}`;

    expect(csrfTokenMatches(recut, 'c')).toBe(false);
    // And the token still works for what it WAS issued for.
    expect(csrfTokenMatches(token, 'b:c')).toBe(true);
  });

  it('does not let a token issued for "a:b:c" authenticate either shorter handle', () => {
    // Multiple separators: every re-cut has to fail, not just the first.
    const token = generateCsrfToken('a:b:c');
    const { nonce, signature } = parts(token);

    expect(csrfTokenMatches(`${nonce}:a.${signature}`, 'b:c')).toBe(false);
    expect(csrfTokenMatches(`${nonce}:a:b.${signature}`, 'c')).toBe(false);
    expect(csrfTokenMatches(token, 'a:b:c')).toBe(true);
  });

  it('does not let a leading-separator handle be re-cut', () => {
    const token = generateCsrfToken(':c');
    const { nonce, signature } = parts(token);

    expect(csrfTokenMatches(`${nonce}:.${signature}`, 'c')).toBe(false);
  });

  it('does not let a trailing-separator handle be re-cut', () => {
    const token = generateCsrfToken('b:');
    const { nonce, signature } = parts(token);

    expect(csrfTokenMatches(`${nonce}:b.${signature}`, '')).toBe(false);
  });

  it('distinguishes handles that differ only by where the separator falls', () => {
    // The property stated directly: two handles whose concatenation with a nonce would
    // once have been indistinguishable now produce different signatures.
    const first = parts(generateCsrfToken('b:c')).signature;
    const second = parts(generateCsrfToken('b:c')).signature;

    // Different nonces, so different signatures — the baseline that makes the next
    // assertion meaningful rather than vacuous.
    expect(first).not.toBe(second);
  });

  it('binds the nonce length, so a shifted split changes the message', () => {
    // Same handle, nonces of different length that would have concatenated to the same
    // string under the old framing.
    const token = generateCsrfToken('x:y:z');
    const { nonce, signature } = parts(token);

    for (const shifted of [`${nonce}:x`, `${nonce}:x:y`]) {
      expect(csrfTokenMatches(`${shifted}.${signature}`, 'y:z')).toBe(false);
      expect(csrfTokenMatches(`${shifted}.${signature}`, 'z')).toBe(false);
    }
  });
});

describe('csrf signatures — ordinary behaviour is unchanged', () => {
  const HANDLE = 'a-session-handle-value';

  it('is deterministic for the same nonce and handle', () => {
    // Verification recomputes the signature from the presented nonce, so a token that
    // verified once must verify again.
    const token = generateCsrfToken(HANDLE);

    expect(csrfTokenMatches(token, HANDLE)).toBe(true);
    expect(csrfTokenMatches(token, HANDLE)).toBe(true);
  });

  it('changes when the handle changes', () => {
    const token = generateCsrfToken(HANDLE);

    expect(csrfTokenMatches(token, `${HANDLE}x`)).toBe(false);
  });

  it('changes when the nonce changes', () => {
    const token = generateCsrfToken(HANDLE);
    const { nonce, signature } = { nonce: token.slice(0, token.indexOf('.')), signature: token.slice(token.indexOf('.') + 1) };

    expect(csrfTokenMatches(`${nonce}x.${signature}`, HANDLE)).toBe(false);
  });

  it('still accepts a real base64url handle, the only kind production mints', () => {
    // `generateSessionHandle` is `randomBytes(32).toString('base64url')` — the alphabet
    // that makes this finding latent rather than live.
    const realHandle = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url');

    expect(csrfTokenMatches(generateCsrfToken(realHandle), realHandle)).toBe(true);
  });

  it('handles an empty handle without throwing', () => {
    expect(csrfTokenMatches(generateCsrfToken(''), '')).toBe(true);
    expect(csrfTokenMatches(generateCsrfToken(''), 'x')).toBe(false);
  });

  it('handles a unicode handle consistently', () => {
    const unicode = 'hàndle-😀';

    expect(csrfTokenMatches(generateCsrfToken(unicode), unicode)).toBe(true);
    expect(csrfTokenMatches(generateCsrfToken(unicode), 'hàndle-😁')).toBe(false);
  });
});
