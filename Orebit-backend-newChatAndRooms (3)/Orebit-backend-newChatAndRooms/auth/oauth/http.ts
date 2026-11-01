import { Logger } from '@nestjs/common';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * The outbound HTTP the non-Google adapters need.
 *
 * `google-auth-library` brings its own transport, retries and key cache. The other
 * four providers have no such library here, and pulling one in per provider would
 * be four dependencies to audit for what amounts to two request shapes. These are
 * those two shapes.
 *
 * ─── Every call is bounded, and that is the point ───────────────────────────
 *
 * A provider's token endpoint is a third party on the critical path of a login. It
 * can be slow, and `fetch` has NO default timeout — an unanswered socket would hold
 * the request until the client gave up, which is precisely the failure the mail
 * service was restructured to remove. `AbortSignal.timeout` is therefore not
 * optional decoration; it is the only thing bounding a sign-in.
 */

const logger = new Logger('OauthHttp');

/**
 * Ten seconds, covering the whole exchange rather than one socket phase.
 *
 * Long enough for a healthy provider on a bad network, short enough that a wedged
 * endpoint fails the login rather than occupying it. A user who waits eleven
 * seconds and is told to try again is better served than one who waits ninety.
 */
const TIMEOUT_MS = 10_000;

/**
 * Cap what we will read from a provider.
 *
 * A userinfo response is a few hundred bytes. Without a cap, a compromised or
 * merely broken endpoint could stream indefinitely into this process's memory —
 * `res.json()` has no size limit of its own. Read as text, measure, then parse.
 */
const MAX_BODY_BYTES = 256 * 1024;

/** POST an `application/x-www-form-urlencoded` body — every OAuth token endpoint. */
export async function postForm(
  url: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<unknown> {
  return request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...headers,
    },
    body: new URLSearchParams(body).toString(),
  });
}

/** GET a JSON document — userinfo endpoints and JWKS documents. */
export async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  return request(url, { method: 'GET', headers: { accept: 'application/json', ...headers } });
}

/**
 * One request, one failure mode.
 *
 * Everything that can go wrong outbound — DNS, TLS, timeout, a 400 from the
 * provider, a body that is not JSON — collapses to `OAUTH_EXCHANGE_FAILED`. That is
 * deliberate: they are all "the provider did not complete this authorization", the
 * client's remedy is identical in every case, and distinguishing them on the wire
 * would tell a caller about our egress rather than about their sign-in.
 *
 * The detail is not lost, it moves to the log. `status` and a truncated body are
 * what actually diagnose a misconfigured client secret, and they must never travel
 * to the client — a provider's error body can echo request parameters back.
 */
async function request(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // Includes the timeout: an aborted fetch rejects rather than resolving.
    logger.warn({ url, err: describe(err) }, 'oauth provider request failed');
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }

  const text = await readCapped(response, url);

  if (!response.ok) {
    logger.warn(
      { url, status: response.status, body: text.slice(0, 500) },
      'oauth provider returned an error',
    );
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    logger.warn({ url, body: text.slice(0, 200) }, 'oauth provider response was not json');
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }
}

/**
 * Read the body, refusing one that will not fit.
 *
 * Streamed rather than `res.text()` so the cap is enforced as bytes arrive. Calling
 * `text()` and checking its length afterwards would have already buffered whatever
 * was sent, which is the thing being defended against.
 */
async function readCapped(response: Response, url: string): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      logger.warn({ url, bytes: total }, 'oauth provider response exceeded the body cap');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** The fields that identify an outbound failure, without the stack. */
function describe(err: unknown): Record<string, unknown> {
  if (typeof err !== 'object' || err === null) return { message: String(err) };
  const e = err as Record<string, unknown>;
  return { name: e['name'], message: e['message'], code: e['code'] };
}

/**
 * Read a string field from a parsed provider response, or refuse.
 *
 * Provider responses are `unknown` on arrival and every adapter needs the same
 * three lines to get a required string out of one. Centralised because the failure
 * has to be uniform: a missing `access_token` and a missing `sub` are both "the
 * provider did not complete this authorization", and an adapter that reached for
 * `(body as any).sub` would turn a shape change into `undefined` flowing onward as
 * an identity subject.
 */
export function requireString(body: unknown, field: string, context: string): string {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== 'string' || value === '') {
    logger.warn({ field, context }, 'oauth provider response missing a required field');
    throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
  }
  return value;
}

/** Read an optional string field, normalising absent/empty/wrong-type to null. */
export function optionalString(body: unknown, field: string): string | null {
  const value = (body as Record<string, unknown> | null)?.[field];
  return typeof value === 'string' && value !== '' ? value : null;
}
