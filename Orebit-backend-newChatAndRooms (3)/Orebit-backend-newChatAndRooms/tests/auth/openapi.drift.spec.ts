import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AuthRoutes } from '../../auth/auth.routes';
import { TwoFactorRoutes } from '../../src/2fa/2fa.routes';
import { AppRoutes } from '../../src/app.routes';
import { AntiPhishingRoutes } from '../../src/settings/antiPhishing/antiPhishing.routes';
import { DeleteAccountRoutes } from '../../src/settings/delete-account/delete-account.routes';
import { EmailChangeRoutes } from '../../src/settings/email/email.routes';
import { LinkAccountsRoutes } from '../../src/settings/link-accounts/link-accounts.routes';
import { PasswordRoutes } from '../../src/settings/password/password.routes';
import { PaymentPinRoutes } from '../../src/settings/paymentPin/payment-pin.routes';
import { SettingsRoutes } from '../../src/settings/settings.routes';
import { UsernameRoutes } from '../../src/settings/username/username.routes';
import { ChatRoutes } from '../../src/social/chat/chat.routes';
import { ChatStaffRoutes } from '../../src/social/chat/chat.staff.routes';
import { ChatSocialRoutes } from '../../src/social/chat/chat.social.routes';
import { DmRoutes } from '../../src/social/chat/dm/dm.routes';
import { SupportRoutes } from '../../src/social/chat/support/support.routes';
import { RainRoutes } from '../../src/social/rain/rain.routes';

/**
 * ═══ THE SPEC MUST NOT DRIFT FROM THE ROUTE TABLE ═══════════════════════════
 *
 * `openapi.json` is hand-maintained and served statically — `src/openapi.ts` reads
 * the file, there is no `SwaggerModule` generating it. So nothing except this test
 * notices when a route ships undocumented, and four already had: `POST /auth/link`,
 * `GET /auth/2fa`, `POST /auth/2fa` and `POST /auth/2fa/verify` were all live and
 * absent from the published contract, along with the `mfa_required` login outcome
 * and the `x-elevation-ticket` header. Frontend developers could not integrate the
 * new happy paths from the spec at all.
 *
 * The list is derived from Nest's own decorator metadata rather than written out by
 * hand, because a hand-written list is a second thing to forget to update.
 */

interface RouteEntry {
  readonly method: string;
  readonly path: string;
}

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

/**
 * Every route a controller class declares, read from `@Controller` and the method
 * decorators.
 *
 * Reflection rather than an HTTP probe: this has to run without a database, a Redis
 * or a listening server, and the question being asked is about the route TABLE, not
 * about whether a handler works.
 */
function routesOf(controller: new (...args: never[]) => unknown): RouteEntry[] {
  const prefix = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
  const proto = controller.prototype as object;

  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = (proto as Record<string, unknown>)[name];
      if (typeof handler !== 'function') return [];

      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const routePath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (verb === undefined) return [];

      const method = METHOD_NAMES[verb];
      if (method === undefined) return [];

      // `@Controller('auth')` + `@Post('login')` → `/auth/login`; a bare `@Post()`
      // on a prefixed controller → `/auth/2fa`.
      const segments = [prefix, routePath ?? '']
        .map((s) => s.replace(/^\/+|\/+$/g, ''))
        .filter((s) => s.length > 0);

      // Nest writes a parameter as `:roomId`, OpenAPI as `{roomId}`.
      return [{ method, path: `/${segments.join('/')}`.replace(/:(\w+)/g, '{$1}') }];
    });
}

/**
 * Every controller class in the service.
 *
 * `SettingsRoutes` and `PaymentPinRoutes` both declare `@Controller('settings')` — Nest
 * merges them into one prefix, and this list is why that is safe to do: a second class
 * on an existing prefix is invisible to a check that enumerates PREFIXES, and would
 * have shipped three undocumented routes. Enumerate classes, not prefixes.
 */
const runtimeRoutes = [
  ...routesOf(AppRoutes),
  ...routesOf(AuthRoutes),
  ...routesOf(TwoFactorRoutes),
  ...routesOf(SettingsRoutes),
  ...routesOf(PaymentPinRoutes),
  ...routesOf(EmailChangeRoutes),
  ...routesOf(UsernameRoutes),
  ...routesOf(PasswordRoutes),
  ...routesOf(AntiPhishingRoutes),
  ...routesOf(LinkAccountsRoutes),
  ...routesOf(DeleteAccountRoutes),
  ...routesOf(ChatRoutes),
  ...routesOf(ChatStaffRoutes),
  ...routesOf(ChatSocialRoutes),
  ...routesOf(DmRoutes),
  ...routesOf(SupportRoutes),
  ...routesOf(RainRoutes),
];

const spec = JSON.parse(readFileSync(join(process.cwd(), 'openapi.json'), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

describe('openapi.json covers every runtime route', () => {
  it('found the route table at all', () => {
    // A guard on the reflection itself: if Nest changes its metadata keys this test
    // would otherwise pass vacuously by finding nothing to check.
    expect(runtimeRoutes.length).toBeGreaterThan(8);
  });

  it.each(runtimeRoutes.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r] as const))(
    '%s is documented',
    (_label, route) => {
      const documented = spec.paths[route.path];
      expect(documented, `openapi.json has no path "${route.path}"`).toBeDefined();
      expect(
        documented?.[route.method],
        `openapi.json documents "${route.path}" but not its ${route.method.toUpperCase()}`,
      ).toBeDefined();
    },
  );

  it('documents no path that does not exist at runtime', () => {
    // The other direction. A spec describing a route nobody serves sends a client
    // after a 404, which is worse than an undocumented route they never try.
    const live = new Set(runtimeRoutes.map((r) => `${r.method} ${r.path}`));
    const verbs = Object.values(METHOD_NAMES);
    const stale = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods)
        // Only HTTP verbs. A path object also carries `parameters`, `summary` and
        // friends, and treating those as undocumented routes would be nonsense.
        .filter((key) => verbs.includes(key))
        .filter((method) => !live.has(`${method} ${path}`))
        .map((method) => `${method.toUpperCase()} ${path}`),
    );

    expect(stale).toEqual([]);
  });
});

describe('openapi.json documents the security surface, not just the paths', () => {
  const raw = JSON.stringify(spec);

  it.each([
    ['the mfa_required login outcome', 'mfa_required'],
    // Was `mfaToken`. The half-finished sign-in is named by the same `loginId`
    // the flow started with, so a client integrating from this spec must find the
    // handle described on BOTH routes or it cannot carry one across.
    ['the loginId that names an in-flight sign-in', 'loginId'],
    ['the signupId that names an in-flight registration', 'signupId'],
    ['the elevation ticket header', 'x-elevation-ticket'],
    ['the context-mismatch refusal', 'mfa_context_mismatch'],
    ['the step-not-valid refusal', 'mfa_step_invalid'],
    ['the credential-change email code', 'credential-otp'],
  ])('mentions %s', (_what, needle) => {
    // These are the pieces a client cannot integrate without: an outcome it must
    // handle, a header it must send, and a refusal it must explain.
    expect(raw).toContain(needle);
  });

  /**
   * The other half of the same contract: what the spec must NOT still describe.
   *
   * A removed mechanism left in the published spec is worse than an undocumented
   * one — a client implements it, it appears to work because the server ignores
   * the extra field, and the failure surfaces later as "my cookie jar stopped
   * mattering". These three are the transports this migration deleted.
   */
  it.each([
    ['the removed registration cookie', 'orebit_reg='],
    ['the removed registration header', 'X-Registration-Token'],
    ['the removed step-up header', 'x-step-up-token'],
    ['the renamed mfa handle', 'mfaToken'],
  ])('no longer documents %s as something to send', (_what, needle) => {
    // Prose that says a thing was REMOVED is fine and is why these needles are
    // matched against the request surface rather than the whole document.
    const surface = JSON.stringify({
      paths: (spec as { paths: unknown }).paths,
      schemas: (spec as { components?: { schemas?: unknown } }).components?.schemas,
    });
    const mentions = surface.split(needle).length - 1;
    const explanations = surface.split('have both been removed').length - 1;
    expect(mentions).toBeLessThanOrEqual(explanations);
  });
});

describe('the Postman collection is generated from the same spec', () => {
  /**
   * `docs/postman/orebit-auth.postman_collection.json` is built from `openapi.json` by
   * `docs/postman/generate.ts`. A hand-written collection would be a THIRD copy of the
   * contract after the code and the spec, and the one nobody remembers to update —
   * which is exactly how the 2FA routes came to be missing from the spec.
   *
   * This test does not re-derive the collection; it checks the two agree on the set of
   * routes. If it fails, run `npx tsx docs/postman/generate.ts`.
   */

  /**
   * ─── Why this read is guarded ──────────────────────────────────────────────
   *
   * The collection is a curated artifact that `generate.ts` AUGMENTS rather than
   * creates — the generator reads it, adds the folders it owns, and writes it back —
   * so it cannot bootstrap itself, and it is not checked in on every branch. This
   * read used to run at module scope, which meant one absent file threw during
   * collection and took the whole spec with it: the two `openapi.json` suites above,
   * which have nothing to do with Postman, never ran at all. A missing generated
   * artifact should not be able to hide real spec drift.
   *
   * So: absent is skipped and loudly labelled, present is checked as strictly as
   * before. The `it` that follows never silently passes on nothing.
   */
  const collectionPath = join(process.cwd(), 'docs/postman/orebit-auth.postman_collection.json');
  const raw = existsSync(collectionPath) ? readFileSync(collectionPath, 'utf8') : null;

  const requestNames =
    raw === null
      ? []
      : (JSON.parse(raw) as { item: { item: { name: string }[] }[] }).item.flatMap((folder) =>
          folder.item.map((i) => i.name),
        );

  it.runIf(raw === null)('is absent on this branch, so the checks below are skipped', () => {
    // Not a silent skip: this states the reason in the report, so "all green" never
    // means "the collection agrees" when the collection does not exist.
    expect(raw).toBeNull();
  });

  it.runIf(raw !== null).each(
    // Chat and social routes have their own collection (docs/postman/orebit-chat.postman_collection.json), checked in chat.openapi.spec.ts.
    runtimeRoutes
      .filter((r) => !r.path.startsWith('/social'))
      .map((r) => [`${r.method.toUpperCase()} ${r.path}`, r] as const),
  )('%s appears in the collection', (label) => {
    // Multi-action routes appear once per action ("POST /auth/2fa — totp-add"), so a
    // prefix match is the right comparison rather than equality.
    expect(
      requestNames.some((name) => name === label || name.startsWith(`${label} —`)),
      `no Postman request for "${label}" — run: npx tsx docs/postman/generate.ts`,
    ).toBe(true);
  });

  it.runIf(raw !== null)('splits multi-action routes into one request per action', () => {
    // The property that makes the collection usable: a single "POST /auth/2fa" with
    // ten mutually exclusive shapes squashed together would be worse than nothing.
    const twoFactor = requestNames.filter((n) => n.startsWith('POST /auth/2fa —'));
    expect(twoFactor.length).toBeGreaterThan(5);
    expect(twoFactor).toContain('POST /auth/2fa — credential-otp');
  });
});
