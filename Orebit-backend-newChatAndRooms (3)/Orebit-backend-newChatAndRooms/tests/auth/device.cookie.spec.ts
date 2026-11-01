import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEVICE } from '../../auth/auth.constants';
import { deviceCookie } from '../../auth/security/device.cookie';
import { pepperedHash } from '../../auth/auth.utility';

/**
 * The device cookie is a rate-limit bucket, so the question these tests ask is not
 * "is it stable" — it always was — but "can a caller choose its own".
 *
 * Under the previous shape-only check it could: any 43-character base64url string
 * was accepted, so a client could mint a fresh device quota per request and every
 * per-device limit in the policy was decorative. That is what `forged` covers.
 */

function request(cookie?: string): FastifyRequest {
  return { cookies: cookie === undefined ? {} : { [DEVICE.COOKIE_NAME]: cookie } } as FastifyRequest;
}

function reply(): FastifyReply & { setCookie: ReturnType<typeof vi.fn> } {
  const setCookie = vi.fn();
  return { setCookie } as unknown as FastifyReply & { setCookie: ReturnType<typeof vi.fn> };
}

/** The value the server would have written for `deviceId`. */
function issued(deviceId: string): string {
  return `${deviceId}.${pepperedHash(deviceId, 'device-sig')}`;
}

/** Mint one the way the route would, and return both halves. */
function mint(): { deviceId: string; cookie: string } {
  const res = reply();
  const deviceId = deviceCookie(request(), res);
  return { deviceId, cookie: res.setCookie.mock.calls[0]?.[1] as string };
}

describe('deviceCookie — issuing', () => {
  it('issues a signed cookie when there is none', () => {
    const res = reply();
    const deviceId = deviceCookie(request(), res);

    expect(res.setCookie).toHaveBeenCalledOnce();
    const [name, value, options] = res.setCookie.mock.calls[0] as [string, string, Record<string, unknown>];

    expect(name).toBe(DEVICE.COOKIE_NAME);
    expect(value).toBe(issued(deviceId));
    // Script must not be able to read a value that groups a user's sessions, and the
    // cookie must not ride along on cross-site requests.
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: DEVICE.COOKIE_PATH });
  });

  it('returns the bare id, not the signed value', () => {
    // `clientContextOf` hashes what it is given into `deviceKey`, and that key is
    // what reaches `trusted_devices`. Returning the signed form would change every
    // stored key the first time the signature format was touched.
    const { deviceId, cookie } = mint();

    expect(cookie.startsWith(`${deviceId}.`)).toBe(true);
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('signs with a domain distinct from the stored device key', () => {
    // If the signature were `pepperedHash(id, 'device')` it would be byte-identical
    // to the value persisted on `trusted_devices` — so read access to that table
    // would be enough to forge a cookie for any device in it.
    const { deviceId, cookie } = mint();
    const signature = cookie.slice(cookie.indexOf('.') + 1);

    expect(signature).not.toBe(pepperedHash(deviceId, 'device'));
  });

  it('gives two browsers different ids', () => {
    expect(mint().deviceId).not.toBe(mint().deviceId);
  });
});

describe('deviceCookie — accepting', () => {
  it('accepts a cookie it issued and does not reissue', () => {
    const { deviceId, cookie } = mint();

    const res = reply();
    expect(deviceCookie(request(cookie), res)).toBe(deviceId);
    // The id has to survive across requests or it is not a device bucket at all.
    expect(res.setCookie).not.toHaveBeenCalled();
  });
});

describe('deviceCookie — rejecting', () => {
  /** Every one of these must be refused AND replaced, never trusted. */
  const rejected: readonly [string, string][] = [
    [
      'a client-minted id in the pre-signing format',
      // Exactly what the old shape check accepted, and the whole reason for this
      // change: 43 valid characters and no signature.
      'A'.repeat(43),
    ],
    ['an id with a wrong signature', `${'A'.repeat(43)}.${'0'.repeat(64)}`],
    ['an empty signature', `${'A'.repeat(43)}.`],
    ['an empty id', `.${'0'.repeat(64)}`],
    ['a bare separator', '.'],
    ['an id of the wrong length', `${'A'.repeat(20)}.${'0'.repeat(64)}`],
    ['an id with characters outside base64url', `${'A'.repeat(42)}!.${'0'.repeat(64)}`],
    ['nonsense', 'not-a-cookie'],
    ['an empty value', ''],
  ];

  it.each(rejected)('refuses %s and issues a fresh one', (_label, value) => {
    const res = reply();
    const deviceId = deviceCookie(request(value), res);

    expect(res.setCookie).toHaveBeenCalledOnce();
    expect(res.setCookie.mock.calls[0]?.[1]).toBe(issued(deviceId));
    // The forged value must not become the bucket.
    expect(value.startsWith(deviceId)).toBe(false);
  });

  it('will not let a caller mint unlimited buckets by guessing the format', () => {
    // The attack the signature closes, stated as a test: a caller that invents its
    // own ids gets a server-issued one back every time, so it cannot choose which
    // rate-limit bucket it lands in.
    const chosen = Array.from({ length: 5 }, (_, i) => `${String(i).repeat(43)}`);

    const accepted = chosen.filter((value) => deviceCookie(request(value), reply()) === value);

    expect(accepted).toEqual([]);
  });

  it('does not accept a signature lifted from a different id', () => {
    // Signatures are per-id, so one cannot be transplanted onto another id to make a
    // second valid bucket out of one legitimate cookie.
    const a = mint();
    const b = mint();
    const transplanted = `${b.deviceId}.${a.cookie.slice(a.cookie.indexOf('.') + 1)}`;

    const res = reply();
    expect(deviceCookie(request(transplanted), res)).not.toBe(b.deviceId);
    expect(res.setCookie).toHaveBeenCalledOnce();
  });
});
