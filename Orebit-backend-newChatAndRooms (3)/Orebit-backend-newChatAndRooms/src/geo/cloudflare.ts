import type { IncomingHttpHeaders } from 'node:http';
import { config } from '../config';
import { normaliseCountry } from '../utils/country';

/**
 * ═══ THE COUNTRY CLOUDFLARE REPORTS FOR ONE REQUEST ════════════════════════
 *
 * A pure function, not an injectable and not a `GeoResolver`. Both of those are
 * deliberate.
 *
 * ─── Why not a service ──────────────────────────────────────────────────────
 *
 * It reads a header and compares strings. There is no collaborator to inject, no
 * state to hold and no I/O to fail, so an `@Injectable` would add a constructor
 * dependency to every caller in order to hold nothing — the argument
 * `auth/security/security-cooldown.ts` makes for the same shape, and the reason
 * `ipClassOf` is a function in auth/auth.utility.ts rather than a provider.
 *
 * ─── Why not bound as GEO_RESOLVER ──────────────────────────────────────────
 *
 * `GeoResolver.resolve(ip)` answers "which country is this ADDRESS in" — a lookup
 * against a provider, asynchronous, and answerable for any address you hand it. This
 * answers "which country did the edge say THIS REQUEST came from" — a header read,
 * synchronous, and meaningless without the request. Same-looking output, different
 * question, different failure mode, different trust boundary. Forcing this behind that
 * port would mean inventing an `ip` argument it ignores, and would let a caller believe
 * it could resolve a country for an arbitrary address, which it cannot.
 *
 * `NullGeoResolver` stays bound to `GEO_RESOLVER` and keeps serving registration's
 * signup-country suggestion. The two do not compete.
 */

/** The header Cloudflare sets. Lowercase — Node normalises incoming header names. */
const COUNTRY_HEADER = 'cf-ipcountry';

/**
 * Values Cloudflare sends that are NOT countries.
 *
 * `XX` is "could not determine". `T1` is a Tor exit node. Both are documented
 * Cloudflare values and both would pass a naive two-character length check, which is
 * how they would become a "country" the evaluator then compares against history —
 * making every Tor user look like they share one country, and every unresolvable
 * request look like it shares another.
 *
 * Mapped to null so they take the unknown path, which is the honest one.
 */
const NOT_A_COUNTRY: ReadonlySet<string> = new Set(['XX', 'T1']);

/**
 * The country for this request, or null when it cannot be established.
 *
 * ═══ NULL IS AN ANSWER, AND IT IS NEVER "A DIFFERENT COUNTRY" ══════════════
 *
 * Returns null when Cloudflare is not trusted on this deployment, when the header is
 * absent, when it is one of Cloudflare's non-country sentinels, or when it is not a
 * recognised ISO 3166-1 alpha-2 code. Every one of those means "nobody established a
 * country", which the evaluator must treat as no evidence — never as evidence of a
 * new country. See `isNewCountry` in the evaluator.
 *
 * ─── The trust gate ────────────────────────────────────────────────────────
 *
 * `config.trustCloudflareHeaders` is false unless an operator has declared Cloudflare
 * is the ingress AND named trusted proxies. Without both, this header is something a
 * caller can write, and believing it would let them choose whether they look familiar.
 * The gate is checked FIRST, before the header is even read, so on a deployment that
 * is not behind Cloudflare there is no code path from a request header to a
 * classification.
 */
export function cloudflareCountry(headers: IncomingHttpHeaders): string | null {
  if (!config.trustCloudflareHeaders) return null;

  const raw = headers[COUNTRY_HEADER];
  // A repeated header arrives as an array; take the first, matching `headerValue` in
  // auth/auth.utility.ts. A caller sending two is choosing which one we read, so
  // "first" has to be a decision rather than an accident of indexing.
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value === '') return null;

  const upper = value.trim().toUpperCase();
  if (NOT_A_COUNTRY.has(upper)) return null;

  // `normaliseCountry` checks the ISO list in src/utils/country.ts and returns null
  // for anything outside it, so a malformed or unexpected value cannot reach the
  // database as a two-character column value that means nothing.
  return normaliseCountry(upper);
}
