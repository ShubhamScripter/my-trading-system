import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FacebookAdapter } from '../../../auth/oauth/facebook.adapter';
import type { OauthIdentity } from '../../../auth/auth.types';

/**
 * ═══ FACEBOOK NEVER SAYS AN ADDRESS IS VERIFIED, SO NEITHER MAY WE ══════════
 *
 * The adapter used to normalise `emailVerified: email !== null` — "Facebook told us
 * an address" read as "Facebook confirmed that address". Those are different
 * statements and only the first one is on the wire.
 *
 * ─── Why that was not cosmetic ──────────────────────────────────────────────
 *
 * `OauthService` reads this field as `trusted`. A trusted identity registers with
 * `state: 'CREDENTIALS_SET'` and `emailVerified: true` and sends NO OTP, so an
 * address Facebook merely reported entered this service already marked confirmed,
 * having been proven to nobody — and the value that decided it was derived entirely
 * from our own side of the call.
 *
 * ─── What Facebook actually returns ─────────────────────────────────────────
 *
 * The `/me` call here requests `id,name,email,picture.type(large)`. The Graph User
 * node has no email-verification field to add to that list: `email_verified` is the
 * OIDC claim Google and Apple send and does not exist on Facebook's User node, and
 * the legacy `verified` field meant whether the PERSON confirmed their Facebook
 * account by mobile or card — a different question — and was withdrawn from the API.
 *
 * So there is no claim to read, which is why the fix is a literal `false` rather than
 * a lookup. Several tests below feed the adapter fields that LOOK like claims,
 * precisely to pin that it does not start trusting one that Facebook does not send.
 */

const { postForm, getJson } = vi.hoisted(() => ({
  postForm: vi.fn(),
  getJson: vi.fn(),
}));

// Only the two network calls are doubled. `requireString` and `optionalString` are
// the real ones, so the field-reading contract under test is the production one.
vi.mock('../../../auth/oauth/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../auth/oauth/http')>()),
  postForm,
  getJson,
}));

const adapter = new FacebookAdapter();

/** A `/me` body with everything populated. Overrides replace or remove fields. */
const ME = {
  id: '1234567890',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  picture: { data: { url: 'https://cdn.fb.test/ada.jpg', is_silhouette: false } },
};

function respondWith(me: Record<string, unknown>): void {
  postForm.mockResolvedValue({ access_token: 'fb-access-token', token_type: 'bearer' });
  getJson.mockResolvedValue(me);
}

function verify(): Promise<OauthIdentity> {
  return adapter.verify({
    code: 'auth-code',
    redirectUri: 'https://app.example.test/oauth/facebook',
    codeVerifier: 'pkce-verifier',
    expectedNonce: undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── 3. an email on its own proves nothing ────────────────────────────────────

describe('an address in the response does not make it verified', () => {
  it('reports emailVerified false for a fully populated response', async () => {
    // ═══ FINDING #5 ═══════════════════════════════════════════════════════════
    //
    // The exact regression. Under `emailVerified: email !== null` this response —
    // an ordinary, successful Facebook login carrying an address — produced `true`,
    // and that `true` is what let a registration skip our OTP.
    respondWith({ ...ME });

    const identity = await verify();

    expect(identity.email).toBe('ada@example.test');
    expect(identity.emailVerified).toBe(false);
  });

  it('still reports false when the address is the only field present', async () => {
    respondWith({ id: '1234567890', email: 'ada@example.test' });

    expect((await verify()).emailVerified).toBe(false);
  });

  it('declares the capability that matches what it returns', async () => {
    // The declaration and the value have to agree. `assertsEmailVerified` is the
    // reviewable statement of which providers may skip our OTP; leaving it `true`
    // beside a `false` identity would be a lie in the one place a reader checks.
    expect(adapter.capabilities.assertsEmailVerified).toBe(false);

    respondWith({ ...ME });
    expect((await verify()).emailVerified).toBe(false);
  });
});

// ─── 2 & 5. nothing in the response can turn it on ────────────────────────────

describe('no field in a Facebook response produces a verified email', () => {
  /**
   * Facebook sends none of these. They are here because the failure mode this
   * finding describes is inference — the adapter concluding "verified" from
   * something other than a provider assertion — and a response that merely LOOKS
   * like it carries a claim is the next shape that mistake would take.
   */
  it.each([
    ['no verification field at all', {}],
    ['an OIDC-style claim Facebook does not send', { email_verified: true }],
    ['the same claim as a string', { email_verified: 'true' }],
    ['the legacy account-verification field', { verified: true }],
    ['both at once', { email_verified: true, verified: true }],
    ['a null claim', { email_verified: null }],
    ['an unexpected shape', { email_verified: { value: true } }],
  ])('stays false with %s', async (_case, extra) => {
    respondWith({ ...ME, ...(extra as Record<string, unknown>) });

    expect((await verify()).emailVerified).toBe(false);
  });

  it('stays false when Facebook returns no email at all', async () => {
    // The link-only path: the user declined the `email` permission. Unchanged.
    respondWith({ id: '1234567890', name: 'Ada Lovelace' });

    const identity = await verify();

    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['a null', null],
    ['a non-string', 42],
  ])('stays false and reports no email when the address is %s', async (_case, email) => {
    respondWith({ ...ME, email });

    const identity = await verify();

    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });
});

// ─── 4. everything else about the flow is untouched ───────────────────────────

describe('the rest of the Facebook identity is unchanged', () => {
  it('returns the subject, email, name and avatar', async () => {
    respondWith({ ...ME });

    expect(await verify()).toEqual({
      provider: 'FACEBOOK',
      subject: '1234567890',
      email: 'ada@example.test',
      emailVerified: false,
      name: 'Ada Lovelace',
      avatarUrl: 'https://cdn.fb.test/ada.jpg',
    });
  });

  it('drops the silhouette placeholder rather than storing it as an avatar', async () => {
    respondWith({ ...ME, picture: { data: { url: 'https://cdn.fb.test/grey.jpg', is_silhouette: true } } });

    expect((await verify()).avatarUrl).toBeNull();
  });

  it('refuses a response with no id, rather than inventing a subject', async () => {
    respondWith({ email: 'ada@example.test' });

    await expect(verify()).rejects.toMatchObject({ type: 'oauth_exchange_failed' });
  });

  it('exchanges the code by POST, with the PKCE verifier', async () => {
    // A GET would put `client_secret` in a URL, which is the part of a request that
    // reaches access logs by default. Pinned because it is easy to "simplify" away.
    respondWith({ ...ME });

    await verify();

    expect(postForm).toHaveBeenCalledOnce();
    const [url, body] = postForm.mock.calls[0] as [string, Record<string, string>];
    expect(url).toContain('/oauth/access_token');
    expect(body).toMatchObject({ code: 'auth-code', code_verifier: 'pkce-verifier' });
  });

  it('reads /me with appsecret_proof and the same field list as before', async () => {
    // The field list is the evidence for the capability claim: there is no
    // verification field in it because there is none to ask for.
    respondWith({ ...ME });

    await verify();

    const [url] = getJson.mock.calls[0] as [string];
    expect(url).toContain('fields=id%2Cname%2Cemail%2Cpicture.type%28large%29');
    expect(url).toContain('appsecret_proof=');
    expect(url).not.toContain('email_verified');
  });

  it('leaves the other capabilities as they were', async () => {
    // Only the verification signal changed. Facebook still sometimes supplies an
    // address, still supports PKCE, and still has no ID token to carry a nonce.
    expect(adapter.capabilities).toMatchObject({
      flow: 'oauth2-code',
      providesEmail: 'sometimes',
      supportsPkce: true,
      supportsNonce: false,
    });
  });

  it('still builds the same authorization URL and scopes', async () => {
    const url = adapter.authorizationUrl({
      redirectUri: 'https://app.example.test/oauth/facebook',
      state: 'state-value',
      codeChallenge: 'challenge-value',
      nonce: null,
    });

    expect(url).toContain('scope=email%2Cpublic_profile');
    expect(url).toContain('code_challenge=challenge-value');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=state-value');
  });
});
