import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ELEVATION_ACTION } from '../../../src/2fa/elevation';
import { DeleteAccountRoutes } from '../../../src/settings/delete-account/delete-account.routes';

/**
 * ═══ THE ROUTE TABLE IS PART OF THE SECURITY MODEL ══════════════════════════
 *
 * Four assertions that cannot be made anywhere else, because each is about what the
 * DECORATORS say rather than about what a handler does:
 *
 *   - the delete route carries `@RequiresElevation('account.delete')`, which is the
 *     only thing binding the single-use ticket to this write;
 *   - exactly one route is `@Public()`, and it is the recovery one. `@Public()` is
 *     opt-out and fails closed, so an accidental extra one is a silently unauthenticated
 *     endpoint — the class of mistake a reviewer cannot see by reading a service;
 *   - the delete and the verify are SEPARATE paths, because `ElevationGuard` runs before
 *     the body is parsed and would otherwise spend the ticket on the wrong branch;
 *   - no handler takes a `FastifyReply`, which is what makes "this module can never mint
 *     a session cookie" a property of the signatures rather than a rule to remember.
 */

const SOURCE = readFileSync(
  join(process.cwd(), 'src', 'settings', 'delete-account', 'delete-account.routes.ts'),
  'utf8',
);

/**
 * The same file with every comment stripped.
 *
 * The "no FastifyReply" and "no deviceCookie" assertions are about what the CODE does,
 * and that file's documentation explains at length why both are absent — so matching
 * against the raw source would fail on the prose that exists to prevent the very thing
 * being asserted. Stripping comments is what makes those two checks mean what they say.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * `@Public()`'s metadata key is a module-private Symbol in auth/security/guards.ts —
 * deliberately, so nothing outside that file can forge the marker. It is still
 * observable by description, which is what a reviewer reading the decorator sees, and
 * asserting on it here needs no export that would weaken the original decision.
 */
function isPublic(fn: object): boolean {
  const key = Reflect.getMetadataKeys(fn).find(
    (candidate) => typeof candidate === 'symbol' && candidate.description === 'isPublic',
  );
  return key === undefined ? false : Reflect.getMetadata(key, fn) === true;
}

function routeOf(handler: string) {
  const proto = DeleteAccountRoutes.prototype as unknown as Record<string, unknown>;
  const fn = proto[handler] as object;
  return {
    path: Reflect.getMetadata(PATH_METADATA, fn) as string,
    method: Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod,
    elevation: Reflect.getMetadata(ELEVATION_ACTION, fn) as string | undefined,
    public: isPublic(fn),
  };
}

describe('DeleteAccountRoutes — the declared table', () => {
  it('declares the settings prefix, matching ROUTE_GROUPS', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DeleteAccountRoutes)).toBe('settings');
  });

  it('declares four routes at the expected paths and verbs', () => {
    expect(routeOf('status')).toMatchObject({
      path: 'security/delete-account',
      method: RequestMethod.GET,
    });
    expect(routeOf('verify')).toMatchObject({
      path: 'security/delete-account/verify',
      method: RequestMethod.POST,
    });
    expect(routeOf('remove')).toMatchObject({
      path: 'security/delete-account',
      method: RequestMethod.POST,
    });
    expect(routeOf('reactivate')).toMatchObject({
      path: 'security/delete-account/reactivate',
      method: RequestMethod.POST,
    });
  });

  it('uses no verb but GET and POST', () => {
    // Nothing in `src/settings/` uses another, and this route in particular must not:
    // it takes a body, needs CSRF and carries an elevation header, and a `DELETE` with a
    // body is poorly served by intermediaries.
    for (const handler of ['status', 'verify', 'remove', 'reactivate']) {
      expect([RequestMethod.GET, RequestMethod.POST]).toContain(routeOf(handler).method);
    }
  });
});

describe('DeleteAccountRoutes — elevation', () => {
  it('binds the delete to `account.delete` and nothing else', () => {
    expect(routeOf('remove').elevation).toBe('account.delete');
  });

  it('names the action on the ROUTE, not in the body', () => {
    // `ElevationService.spend` compares the action the route declares against the one
    // stamped in the grant. A caller who could name the action at spend time could spend
    // whichever ticket they happen to hold.
    expect(SOURCE).toMatch(/@RequiresElevation\('account\.delete'\)/);
  });

  it('leaves the other three routes unelevated', () => {
    // `verify` must not be: it is where the ticket is EARNED. `status` and `reactivate`
    // are not writes a ticket could authorise.
    for (const handler of ['status', 'verify', 'reactivate']) {
      expect(routeOf(handler).elevation).toBeUndefined();
    }
  });

  it('keeps delete and verify on SEPARATE paths', () => {
    // The bug this prevents is real and has happened here before: `ElevationGuard` runs
    // before the body is parsed and reads the ticket with GETDEL, so a shared handler
    // would destroy a ticket the delete still needed. `POST /auth/link` and
    // `/auth/link/preview` had exactly this defect.
    expect(routeOf('remove').path).not.toBe(routeOf('verify').path);
  });
});

describe('DeleteAccountRoutes — what is public, and what that costs', () => {
  it('makes exactly ONE route public, and it is the recovery one', () => {
    expect(routeOf('reactivate').public).toBe(true);

    // `@Public()` is opt-out and fails closed, so the absence of the marker on the other
    // three IS the statement that they need a session.
    for (const handler of ['status', 'verify', 'remove']) {
      expect(routeOf(handler).public).toBe(false);
    }
  });

  it('keeps the status read authenticated', () => {
    // It reports the caller's own state and needs a principal to have any meaning.
    // Nothing in the recovery flow reads it.
    expect(routeOf('status').public).toBe(false);
    expect(SOURCE).toMatch(/status\(@Req\(\) req: FastifyRequest\)/);
  });

  it('pairs the public route with OptionalAuthGuard, so CSRF still applies', () => {
    // Both guards share `authenticate()`, which is where CSRF is enforced — so a public
    // route that carries a session cookie is still protected against a forged request.
    expect(SOURCE).toMatch(/@Public\(\)\s*\n\s*@UseGuards\(OptionalAuthGuard\)/);
  });
});

describe('DeleteAccountRoutes — no handler can mint a session', () => {
  it('takes no FastifyReply anywhere', () => {
    // The property the module exists to guarantee, enforced by what is ABSENT from the
    // signatures rather than by a check somebody could forget. Without a reply there is
    // nothing to set a cookie on.
    expect(CODE).not.toMatch(/FastifyReply/);
    // Not a vacuous pass: the stripped source still holds the decorators and signatures.
    expect(CODE).toMatch(/@Controller\('settings'\)/);
    expect(CODE).toMatch(/FastifyRequest/);
  });

  it('never reaches for the device cookie', () => {
    // `DEVICE.COOKIE_PATH` is `/auth`, so the browser never sends it to `/settings/*` and
    // calling `deviceCookie` here would MINT A NEW ONE on every request.
    expect(CODE).not.toMatch(/deviceCookie/);
  });

  it('reads only the ip and its class from the request', () => {
    expect(CODE).toMatch(/ipClassOf\(req\.ip\)/);
    // `requirePrincipal` on the three authenticated routes, and nothing else pulled off
    // the request object.
    const reads = [...CODE.matchAll(/req\.([a-zA-Z]+)/g)].map((match) => match[1]);
    expect([...new Set(reads)]).toEqual(['ip']);
  });
});
