import { describe, expect, it } from 'vitest';
import {
  linkCallbackRequestSchema,
  linkStartRequestSchema,
  linkUnlinkRequestSchema,
  linkVerifyRequestSchema,
} from '../../../src/settings/link-accounts/link-accounts.dto';
import { resolveLinkProof } from '../../../src/settings/link-accounts/link-accounts.utility';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * Two things the wire contract has to get right, and one decision table.
 *
 * `.strict()` is a security control here rather than tidiness: Zod strips unknown
 * keys by default, so without it a client sending a field this route does not read
 * would have it silently dropped and get a success it did not ask for.
 *
 * `resolveLinkProof` is a pure decision table, which is why it is tested here rather
 * than through the service — the interesting behaviour is the combinations it
 * REFUSES, and enumerating them should not need a DI container.
 */

describe('linkVerifyRequestSchema', () => {
  it('accepts a bare challenge', () => {
    expect(linkVerifyRequestSchema.safeParse({ action: 'challenge' }).success).toBe(true);
  });

  it('requires the emailed code on verify — it is owed on every path', () => {
    expect(linkVerifyRequestSchema.safeParse({ action: 'verify' }).success).toBe(false);
    expect(
      linkVerifyRequestSchema.safeParse({ action: 'verify', emailCode: '123456' }).success,
    ).toBe(true);
  });

  it('accepts either factor field, and neither', () => {
    const base = { action: 'verify', emailCode: '123456' };
    expect(linkVerifyRequestSchema.safeParse({ ...base, totpCode: '654321' }).success).toBe(true);
    expect(
      linkVerifyRequestSchema.safeParse({ ...base, passkey: { id: 'cred-1' } }).success,
    ).toBe(true);
    expect(linkVerifyRequestSchema.safeParse(base).success).toBe(true);
  });

  it('refuses a password — this ceremony never accepts one', () => {
    // `reauthVerify` does, on an account with no factor. That is the behaviour this
    // module exists to not inherit, and `.strict()` is what stops a client from
    // sending one and believing it mattered.
    const parsed = linkVerifyRequestSchema.safeParse({
      action: 'verify',
      emailCode: '123456',
      password: 'hunter2',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a recovery code — a printed sheet must not attach a provider', () => {
    const parsed = linkVerifyRequestSchema.safeParse({
      action: 'verify',
      emailCode: '123456',
      recoveryCode: 'ABCD-EFGH',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an unknown action', () => {
    expect(linkVerifyRequestSchema.safeParse({ action: 'link-start' }).success).toBe(false);
  });
});

describe('linkStartRequestSchema', () => {
  it('accepts each provider the enum names, in upper case', () => {
    for (const provider of ['GOOGLE', 'X', 'TELEGRAM', 'APPLE', 'FACEBOOK']) {
      expect(linkStartRequestSchema.safeParse({ provider }).success).toBe(true);
    }
  });

  it('refuses lower case — the whole service spells providers one way', () => {
    expect(linkStartRequestSchema.safeParse({ provider: 'google' }).success).toBe(false);
  });

  it('refuses a provider that does not exist', () => {
    expect(linkStartRequestSchema.safeParse({ provider: 'MYSPACE' }).success).toBe(false);
  });

  it('accepts an optional redirect URI and refuses a non-URL', () => {
    expect(
      linkStartRequestSchema.safeParse({
        provider: 'GOOGLE',
        redirectUri: 'https://app.example.com/oauth/callback',
      }).success,
    ).toBe(true);
    expect(
      linkStartRequestSchema.safeParse({ provider: 'GOOGLE', redirectUri: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('refuses a stray action field rather than dropping it', () => {
    // A client that sent `action: 'callback'` here would otherwise spend its
    // elevation ticket on the wrong half of the ceremony.
    expect(
      linkStartRequestSchema.safeParse({ provider: 'GOOGLE', action: 'callback' }).success,
    ).toBe(false);
  });
});

describe('linkCallbackRequestSchema', () => {
  const valid = { provider: 'GOOGLE', code: 'authorization-code', state: 'abc' };

  it('accepts a complete callback', () => {
    expect(linkCallbackRequestSchema.safeParse(valid).success).toBe(true);
  });

  it.each(['provider', 'code', 'state'])('refuses one missing %s', (field) => {
    const body: Record<string, unknown> = { ...valid };
    delete body[field];
    expect(linkCallbackRequestSchema.safeParse(body).success).toBe(false);
  });

  it('refuses an unknown key', () => {
    expect(linkCallbackRequestSchema.safeParse({ ...valid, linkToken: 'x' }).success).toBe(false);
  });
});

describe('resolveLinkProof', () => {
  const NONE = { hasTotp: false, hasPasskey: false };
  const TOTP = { hasTotp: true, hasPasskey: false };
  const PASSKEY = { hasTotp: false, hasPasskey: true };
  const BOTH = { hasTotp: true, hasPasskey: true };

  it('asks for nothing further when nothing is enrolled', () => {
    expect(resolveLinkProof({}, NONE)).toEqual({ ok: true, method: 'none' });
  });

  it('names the totp path when an authenticator answers', () => {
    expect(resolveLinkProof({ totpCode: '654321' }, TOTP)).toEqual({ ok: true, method: 'totp' });
  });

  it('names the passkey path when an assertion answers', () => {
    expect(resolveLinkProof({ passkey: {} }, PASSKEY)).toEqual({ ok: true, method: 'passkey' });
  });

  it('accepts either when both are enrolled', () => {
    expect(resolveLinkProof({ totpCode: '654321' }, BOTH)).toMatchObject({ method: 'totp' });
    expect(resolveLinkProof({ passkey: {} }, BOTH)).toMatchObject({ method: 'passkey' });
  });

  it('refuses both at once rather than silently choosing', () => {
    const resolved = resolveLinkProof({ totpCode: '654321', passkey: {} }, BOTH);
    expect(resolved.ok).toBe(false);
  });

  it('refuses an empty body when a factor is enrolled', () => {
    expect(resolveLinkProof({}, TOTP).ok).toBe(false);
    expect(resolveLinkProof({}, PASSKEY).ok).toBe(false);
  });

  it.each([
    ['a totp code with no authenticator', { totpCode: '654321' }, PASSKEY],
    ['an assertion with no passkey', { passkey: {} }, TOTP],
    ['a totp code with nothing enrolled', { totpCode: '654321' }, NONE],
    ['an assertion with nothing enrolled', { passkey: {} }, NONE],
  ])('refuses %s', (_label, proofs, enrolled) => {
    // Ignoring a proof the account cannot satisfy would answer success while
    // checking nothing.
    expect(resolveLinkProof(proofs, enrolled).ok).toBe(false);
  });
});

describe('the verify intent', () => {
  const parse = (body: Record<string, unknown>) => linkVerifyRequestSchema.safeParse(body);

  it('defaults to link when absent', () => {
    // The backwards-compatibility guarantee. Every client and every stored request
    // written before unlink existed must keep meaning exactly what it meant, which is
    // only true if the default is applied rather than left undefined.
    const parsed = parse({ action: 'verify', emailCode: '123456' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ intent: 'link' });
  });

  it('accepts an explicit unlink', () => {
    const parsed = parse({ action: 'verify', emailCode: '123456', intent: 'unlink' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ intent: 'unlink' });
  });

  it('refuses an intent that is not one of the two writes', () => {
    // Free strings here would mean a ticket stamped with an action no route names —
    // unspendable, and diagnosed as a re-auth failure rather than a typo.
    expect(parse({ action: 'verify', emailCode: '123456', intent: 'remove' }).success).toBe(false);
    expect(parse({ action: 'verify', emailCode: '123456', intent: '' }).success).toBe(false);
  });

  it('does not accept an intent on the challenge branch', () => {
    // `challenge` issues no ticket, so an intent there would describe nothing.
    expect(parse({ action: 'challenge', intent: 'unlink' }).success).toBe(false);
  });
});

describe('the unlink request', () => {
  it('accepts a provider and nothing else', () => {
    const parsed = linkUnlinkRequestSchema.safeParse({ provider: 'GOOGLE' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ provider: 'GOOGLE' });
  });

  it('refuses a provider outside the enum', () => {
    expect(linkUnlinkRequestSchema.safeParse({ provider: 'MYSPACE' }).success).toBe(false);
    expect(linkUnlinkRequestSchema.safeParse({ provider: 'google' }).success).toBe(false);
  });

  it('requires the provider', () => {
    expect(linkUnlinkRequestSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ['a user id', { provider: 'GOOGLE', userId: 'user-2' }],
    ['a provider subject', { provider: 'GOOGLE', subject: 'google-subject-9' }],
    ['a link id', { provider: 'GOOGLE', linkId: 'link-9' }],
    ['a caller-supplied deadline', { provider: 'GOOGLE', unlinkAt: '2026-09-12T00:00:00.000Z' }],
    ['a provider token', { provider: 'GOOGLE', accessToken: 'ya29.a0' }],
  ])('refuses %s rather than ignoring it', (_label, body) => {
    // `.strict()` is doing real work here. Silently dropping any of these would let a
    // client believe it had named another account's link, or set its own deadline,
    // and spend an elevation ticket on a write it did not mean.
    expect(linkUnlinkRequestSchema.safeParse(body).success).toBe(false);
  });
});
