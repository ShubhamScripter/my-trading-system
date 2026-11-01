import { Logger } from '@nestjs/common';
import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { safeEqual } from '../../src/utils/public.utils';
import { getJson } from './http';

/**
 * ID-token verification against a provider's published JWKS.
 *
 * `google-auth-library` does this for Google and caches the keys itself. Apple has
 * no equivalent library here, so this is the same job for any OIDC provider that
 * publishes a key set: fetch the keys, pick the one the token names, verify the
 * signature and the registered claims.
 *
 * ─── Why the signature check is the whole thing ─────────────────────────────
 *
 * An ID token is a bearer assertion about who the user is. Decoding it without
 * verifying — `jwt.decode`, or a hand-rolled base64 split — accepts any well-formed
 * JWT anybody cares to POST at the callback, including one whose `sub` names
 * somebody else's account. That is the entire attack, and it is a one-line mistake
 * to make, which is why no adapter is given a decode helper: `verifyIdToken` is the
 * only way a payload is reachable from this directory.
 *
 * `algorithms` is pinned by the caller and never read from the token header. A
 * verifier that trusts `alg` accepts `none`, and accepts an RSA public key
 * presented as an HMAC secret — both classic and both fatal.
 */

const logger = new Logger('OauthJwks');

/**
 * How long a fetched key set is reused.
 *
 * Providers rotate signing keys on their own schedule and publish the new one
 * before using it, so a stale cache is normally harmless — and `findKey` below
 * refetches on an unknown `kid` regardless, which is the case that actually
 * matters. An hour keeps a login off the network almost always without making a
 * rotation a support incident.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * How long after a refetch we refuse to refetch again.
 *
 * Without it, a token naming a `kid` that genuinely does not exist would fetch the
 * key set on every attempt — so a trivial loop of forged tokens becomes an outbound
 * request amplifier pointed at the provider, and our own rate limit would be
 * measuring the wrong thing. One minute bounds it to something the provider will
 * not notice.
 */
const REFETCH_COOLDOWN_MS = 60 * 1000;

interface CachedKeySet {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly fetchedAt: number;
}

const cache = new Map<string, CachedKeySet>();

export interface IdTokenExpectation {
  /** The JWKS document URL. */
  readonly jwksUri: string;
  /** The `iss` the token must carry, exactly. */
  readonly issuer: string;
  /** The `aud` the token must carry — our client id at this provider. */
  readonly audience: string;
  /** Permitted signature algorithms. Pinned; never taken from the header. */
  readonly algorithms: readonly jwt.Algorithm[];
  /** Who is asking, for the log line. */
  readonly provider: string;
}

/**
 * Verify an ID token and return its claims.
 *
 * Throws `OAUTH_EXCHANGE_FAILED` for anything wrong with the token. The distinction
 * a caller might want — expired versus wrong audience versus bad signature — is
 * deliberately not surfaced: all of them mean this authorization did not complete,
 * and a client cannot act differently on any of them. The reason lands in the log.
 */
export async function verifyIdToken(
  idToken: string,
  expect: IdTokenExpectation,
): Promise<JwtPayload> {
  const kid = readKid(idToken, expect.provider);
  const key = await findKey(expect.jwksUri, kid, expect.provider);

  try {
    const payload = jwt.verify(idToken, key, {
      algorithms: [...expect.algorithms],
      audience: expect.audience,
      issuer: expect.issuer,
      // The provider's clock and ours are both authoritative about nothing. Thirty
      // seconds absorbs ordinary drift without meaningfully extending the life of
      // a token — these are single-use and consumed seconds after issue.
      clockTolerance: 30,
    });

    if (typeof payload === 'string') {
      // A token whose payload is a bare string carries no claims, so there is no
      // `sub` to identify anybody with.
      logger.warn({ provider: expect.provider }, 'id token payload was not an object');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    return payload;
  } catch (err) {
    if (err instanceof ProblemException) throw err;
    logger.warn(
      { provider: expect.provider, err: err instanceof Error ? err.message : String(err) },
      'id token verification failed',
    );
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }
}

/**
 * Read `kid` from the header without trusting anything else in the token.
 *
 * This is the one place a token is looked at before its signature is checked, and
 * it reads exactly one field — which key to verify with. Nothing about identity is
 * taken from here.
 */
function readKid(idToken: string, provider: string): string {
  const header = idToken.split('.')[0];
  if (header === undefined || header === '') {
    logger.warn({ provider }, 'id token was not a jwt');
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }

  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as unknown;
    const kid = (parsed as Record<string, unknown> | null)?.['kid'];
    if (typeof kid !== 'string' || kid === '') {
      logger.warn({ provider }, 'id token header carried no kid');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }
    return kid;
  } catch (err) {
    if (err instanceof ProblemException) throw err;
    logger.warn({ provider }, 'id token header was not decodable json');
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }
}

/**
 * The verifying key for one `kid`, fetching the set if needed.
 *
 * An unknown `kid` against a cache that is merely old triggers exactly one
 * refetch — that is a key rotation, and it is the case a TTL alone handles badly:
 * the provider starts signing with a new key the moment it publishes it, so waiting
 * out an hour would fail every login in between.
 */
async function findKey(jwksUri: string, kid: string, provider: string): Promise<KeyObject> {
  const cached = cache.get(jwksUri);
  const fresh = cached !== undefined && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

  const hit = cached?.keys.get(kid);
  if (hit !== undefined && fresh) return hit;

  // Cached but the kid is unknown, and we refetched recently: do not go again. The
  // stale key is still worth trying — if it matches, the token verifies.
  if (cached !== undefined && Date.now() - cached.fetchedAt < REFETCH_COOLDOWN_MS) {
    if (hit !== undefined) return hit;
    logger.warn({ provider, kid }, 'id token named an unknown signing key');
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }

  const keys = await fetchKeySet(jwksUri, provider);
  cache.set(jwksUri, { keys, fetchedAt: Date.now() });

  const found = keys.get(kid);
  if (found === undefined) {
    logger.warn({ provider, kid }, 'id token named a signing key the provider does not publish');
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }
  return found;
}

/**
 * Fetch and parse a JWKS document into usable keys.
 *
 * A key that will not convert is skipped rather than failing the whole set: key
 * sets carry algorithms we do not use and occasionally entries Node declines, and
 * one unusable entry must not take out the key beside it that would have verified.
 */
async function fetchKeySet(
  jwksUri: string,
  provider: string,
): Promise<ReadonlyMap<string, KeyObject>> {
  const document = await getJson(jwksUri);
  const rawKeys = (document as Record<string, unknown> | null)?.['keys'];

  if (!Array.isArray(rawKeys)) {
    logger.error({ provider, jwksUri }, 'jwks document had no keys array');
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }

  const keys = new Map<string, KeyObject>();
  for (const raw of rawKeys) {
    const kid = (raw as Record<string, unknown> | null)?.['kid'];
    if (typeof kid !== 'string') continue;
    try {
      // Node accepts a JWK directly, so there is no PEM assembly to get wrong.
      keys.set(kid, createPublicKey({ key: raw as JsonWebKey, format: 'jwk' }));
    } catch (err) {
      logger.warn(
        { provider, kid, err: err instanceof Error ? err.message : String(err) },
        'skipping an unusable jwks entry',
      );
    }
  }

  if (keys.size === 0) {
    logger.error({ provider, jwksUri }, 'jwks document yielded no usable keys');
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }

  logger.log({ provider, keys: keys.size }, 'jwks fetched');
  return keys;
}

/** Drop every cached key set. Exists for tests, which must not share state. */
export function resetJwksCacheForTests(): void {
  cache.clear();
}

/**
 * The ID token's `nonce` must be the one we put in the authorization request.
 *
 * Shared by every `oidc-code` adapter rather than written per provider, because it
 * is the check most easily forgotten: the token verifies, the audience matches, the
 * signature is genuine — and it was minted for an authorization request an attacker
 * started, then injected into somebody else's callback. `state` does not catch that
 * (it is ours and it matched); only the nonce does.
 *
 * `safeEqual` rather than `===`, for consistency with every other secret comparison
 * in the service. Timing is not the threat — the expected value is already in our
 * hand and cannot be iterated against — but a codebase where some secret
 * comparisons are constant-time and some are not is one where the next reader has
 * to work out which kind this is.
 *
 * A token that omits `nonce` entirely is refused just as firmly as one carrying the
 * wrong value: providers echo what they are given, so a missing claim means the
 * token was minted for a request that did not include one, i.e. not ours.
 */
export function assertNonce(
  actual: unknown,
  expected: string | undefined,
  provider: string,
): void {
  // A state entry written before nonces were sent carries nothing to compare. The
  // tolerance is bounded by OAUTH.STATE_TTL_SECONDS — see the note in oauth.service.
  if (expected === undefined) return;

  if (typeof actual !== 'string' || !safeEqual(actual, expected)) {
    logger.warn({ provider, hasNonce: typeof actual === 'string' }, 'id token nonce did not match the authorization request');
    throw new ProblemException({ type: ERR.OAUTH_NONCE_INVALID });
  }
}
