import { describe, expect, it } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { AuthRoutes } from '../auth/auth.routes';
import { TwoFactorRoutes } from '../src/2fa/2fa.routes';
import { AppRoutes, ROUTE_GROUPS } from '../src/app.routes';
import { SettingsRoutes } from '../src/settings/settings.routes';
import { ChatRoutes } from '../src/social/chat/chat.routes';

/**
 * ═══ THE ROUTE-GROUP REGISTRY MUST MATCH THE CONTROLLERS ════════════════════
 *
 * `ROUTE_GROUPS` in src/app.routes.ts documents every URL prefix this service
 * answers on. Nest derives routing from `@Controller` decorators, so the table
 * drives nothing — which is exactly why it needs a test. Three separate route files
 * carry a comment promising that this spec asserts the correspondence
 * (auth/auth.routes.ts, src/2fa/2fa.routes.ts, src/settings/settings.routes.ts), and
 * until now the file those comments named did not exist: the table could drift from
 * the controllers, or a whole module could ship absent from it, with a green suite.
 *
 * Read from Nest's own metadata rather than a hand-written list, for the same reason
 * openapi.drift.spec.ts does: a hand-written list is a second thing to forget.
 */

const CONTROLLERS = [AppRoutes, AuthRoutes, TwoFactorRoutes, SettingsRoutes, ChatRoutes];

function prefixOf(controller: new (...args: never[]) => unknown): string {
  const raw = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
  return raw.replace(/^\/+|\/+$/g, '');
}

describe('ROUTE_GROUPS', () => {
  it('found the controller metadata at all', () => {
    // A guard on the reflection: if Nest changes its metadata key, every assertion
    // below would pass vacuously by comparing two empty sets.
    expect(CONTROLLERS.map(prefixOf)).toContain('auth');
  });

  it.each(CONTROLLERS.map((c) => [c.name, c] as const))(
    '%s has a row for its prefix',
    (_name, controller) => {
      const prefix = prefixOf(controller);
      expect(
        ROUTE_GROUPS.some((group) => group.prefix === prefix),
        `no ROUTE_GROUPS row for prefix "${prefix}" — add a module, add a row`,
      ).toBe(true);
    },
  );

  it('lists no prefix that no controller serves', () => {
    // The other direction. A registry naming a module that does not exist is worse
    // than one missing a module, because it reads as a promise.
    const live = new Set(CONTROLLERS.map(prefixOf));
    const stale = ROUTE_GROUPS.filter((group) => !live.has(group.prefix)).map((g) => g.prefix);

    expect(stale).toEqual([]);
  });

  it('names each row uniquely, with a description', () => {
    const prefixes = ROUTE_GROUPS.map((g) => g.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);

    for (const group of ROUTE_GROUPS) {
      expect(group.module.length).toBeGreaterThan(0);
      expect(group.description.length).toBeGreaterThan(0);
    }
  });
});
