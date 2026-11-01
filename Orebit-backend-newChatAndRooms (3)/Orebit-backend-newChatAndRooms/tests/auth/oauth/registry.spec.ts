import { describe, expect, it } from 'vitest';
import { AppleAdapter } from '../../../auth/oauth/apple.adapter';
import { FacebookAdapter } from '../../../auth/oauth/facebook.adapter';
import { GoogleAdapter } from '../../../auth/oauth/google.adapter';
import type { OauthProviderAdapter } from '../../../auth/oauth/provider.port';
import { OauthProviderRegistry } from '../../../auth/oauth/registry';
import { TelegramAdapter } from '../../../auth/oauth/telegram.adapter';
import { XAdapter } from '../../../auth/oauth/x.adapter';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';

/**
 * OauthProviderRegistry — the one place a provider can be refused.
 *
 * This is what replaced narrowing the DTO enum to `GOOGLE`, so the cases here are
 * the ones that used to be validation errors. Worth testing carefully: if `require`
 * stopped checking `isConfigured`, a deployment without credentials would reach an
 * adapter and fail inside a token exchange instead of at the door — a 502 blaming
 * the provider for a configuration mistake of ours.
 */

function registry(...adapters: OauthProviderAdapter[]): OauthProviderRegistry {
  return new OauthProviderRegistry(adapters);
}

function problem(call: () => unknown): ProblemException {
  try {
    call();
  } catch (err) {
    if (err instanceof ProblemException) return err;
    throw err;
  }
  throw new Error('expected a ProblemException');
}

describe('OauthProviderRegistry.require', () => {
  it('returns the adapter for a configured provider', () => {
    // `tests/setup.ts` supplies Google credentials, so this is the one provider that
    // resolves in this environment.
    const google = new GoogleAdapter();
    expect(registry(google).require('GOOGLE')).toBe(google);
  });

  it('refuses a provider whose credentials are absent', () => {
    // Apple is deliberately unconfigured in the test env. A 400 naming the provider,
    // not a 502 from a failed exchange — this is our configuration, not their fault.
    const err = problem(() => registry(new AppleAdapter()).require('APPLE'));

    expect(err.type).toBe(ERR.OAUTH_PROVIDER_UNSUPPORTED);
    expect(err.detail).toContain('APPLE');
  });

  it('refuses a provider with no adapter registered at all', () => {
    const err = problem(() => registry(new GoogleAdapter()).require('FACEBOOK'));
    expect(err.type).toBe(ERR.OAUTH_PROVIDER_UNSUPPORTED);
  });

  it('gives the same answer for "not built" and "not configured"', () => {
    // One refusal for both on purpose: they are the same fact from the caller's side
    // — this deployment cannot complete a sign-in with that provider — and telling
    // them apart would report which providers are built but unconfigured, which is
    // deployment shape rather than anything a client can act on.
    const notBuilt = problem(() => registry(new GoogleAdapter()).require('X'));
    const notConfigured = problem(() => registry(new XAdapter()).require('X'));

    expect(notBuilt.type).toBe(notConfigured.type);
  });
});

describe('OauthProviderRegistry — construction', () => {
  it('refuses two adapters for one provider', () => {
    // Fatal rather than last-one-wins: which adapter verified a callback would
    // otherwise depend on module registration order, and that is not something to
    // discover in production.
    expect(() => registry(new GoogleAdapter(), new GoogleAdapter())).toThrow(
      /duplicate oauth adapter/i,
    );
  });

  it('accepts the full production set', () => {
    // The list auth/oauth/index.ts registers. Constructing it here is what catches a
    // provider whose adapter reports the wrong `provider` and so collides with
    // another — the constructor is the only place that can see it.
    expect(() =>
      registry(
        new GoogleAdapter(),
        new AppleAdapter(),
        new FacebookAdapter(),
        new XAdapter(),
        new TelegramAdapter(),
      ),
    ).not.toThrow();
  });
});

describe('provider capabilities are consistent with what each adapter can do', () => {
  const all = [
    new GoogleAdapter(),
    new AppleAdapter(),
    new FacebookAdapter(),
    new XAdapter(),
    new TelegramAdapter(),
  ];

  it('gives every adapter a distinct provider', () => {
    const providers = all.map((adapter) => adapter.provider);
    expect(new Set(providers).size).toBe(all.length);
  });

  it('never claims a nonce without an ID token to carry it', () => {
    // `supportsNonce` may only be true for an `oidc-code` flow. The other flows have
    // no signed assertion to bind, so claiming a nonce would make the service mint
    // one, stash it, and check it against nothing — a control that looks present in
    // the state entry and is not.
    for (const adapter of all) {
      if (adapter.capabilities.supportsNonce) {
        expect(adapter.capabilities.flow).toBe('oidc-code');
      }
    }
  });

  it('claims no PKCE for the flow that has no authorization request', () => {
    for (const adapter of all) {
      if (adapter.capabilities.flow === 'signed-payload') {
        expect(adapter.capabilities.supportsPkce).toBe(false);
        expect(adapter.capabilities.supportsNonce).toBe(false);
      }
    }
  });

  it('has no authorization URL exactly when the flow is signed-payload', () => {
    // The invariant `OauthService.start` relies on to return a null `url`: a code
    // flow must always produce one, and a signed-payload flow never can.
    for (const adapter of all) {
      const url = adapter.authorizationUrl({
        redirectUri: 'https://app.example.test/cb',
        state: 'state',
        codeChallenge: 'challenge',
        nonce: 'nonce',
      });

      expect(url === null).toBe(adapter.capabilities.flow === 'signed-payload');
    }
  });

  it('never claims a verified email for a provider that supplies none', () => {
    // `assertsEmailVerified` decides whether an OAuth registration skips our own
    // OTP. Claiming it while supplying no address would be meaningless today and a
    // trusted-by-default address the day the provider started sending one.
    for (const adapter of all) {
      if (adapter.capabilities.providesEmail === 'never') {
        expect(adapter.capabilities.assertsEmailVerified).toBe(false);
      }
    }
  });
});
