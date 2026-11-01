import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatRoutes } from '../../src/social/chat/chat.routes';
import { ChatStaffRoutes } from '../../src/social/chat/chat.staff.routes';
import { ChatSocialRoutes } from '../../src/social/chat/chat.social.routes';
import { DmRoutes } from '../../src/social/chat/dm/dm.routes';
import { SupportRoutes } from '../../src/social/chat/support/support.routes';
import { RainRoutes } from '../../src/social/rain/rain.routes';

/**
 * The chat documents match the chat routes: every route is in the chat section of openapi.json and in the
 * chat Postman collection, success and error bodies point at the shared Problem shape, and the sign-in is the cookie
 *, never a bearer token.
 */
const ROOT = join(__dirname, '..', '..');
const spec = JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf8')) as {
  paths: Record<
    string,
    Record<
      string,
      { operationId?: string; security?: unknown[]; responses: Record<string, unknown> }
    >
  >;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};
const collection = JSON.parse(
  readFileSync(join(ROOT, 'docs', 'postman', 'orebit-chat.postman_collection.json'), 'utf8'),
) as {
  item: { name: string; item: { name: string; event?: { script: { exec: string[] } }[] }[] }[];
};

const VERBS = ['get', 'post', 'put'];
/** Modules 1–3 (ChatRoutes), the Module 4 staff tools, Module 5, Modules 6–7 (rain), Modules 8–9 and the Module 10 support chat. */
const ROUTE_CLASSES = [ChatRoutes, ChatStaffRoutes, ChatSocialRoutes, DmRoutes, SupportRoutes, RainRoutes];
/** The chat paths and the rain paths (Modules 6–7). */
const CHAT_PATH = (path: string) => path.startsWith('/social/chat') || path.startsWith('/social/rain');
const routes = ROUTE_CLASSES.flatMap((cls) => {
  const proto = cls.prototype as unknown as Record<string, unknown>;
  const base = Reflect.getMetadata('path', cls) as string;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name] as object;
    const path = Reflect.getMetadata('path', handler) as string | undefined;
    const method = Reflect.getMetadata('method', handler) as number | undefined;
    if (path === undefined || method === undefined) return [];
    const full = path === '/' ? `/${base}` : `/${base}/${path}`;
    return [{ method: VERBS[method]!, path: full.replace(/:(\w+)/g, '{$1}') }];
  });
});
const requests = collection.item.flatMap((folder) => folder.item);

describe('openapi.json chat section', () => {
  it('finds the chat routes', () => expect(routes.length).toBe(128));

  it.each(routes.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r] as const))(
    '%s is documented',
    (_l, r) => {
      expect(spec.paths[r.path]?.[r.method], `no ${r.method} ${r.path}`).toBeDefined();
    },
  );

  it('documents no chat route the server does not have', () => {
    const live = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const stale = Object.entries(spec.paths)
      .filter(([path]) => CHAT_PATH(path))
      .flatMap(([path, ops]) =>
        Object.keys(ops)
          .filter((m) => VERBS.includes(m))
          .map((m) => `${m} ${path}`),
      )
      .filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });

  it('answers every error with the shared Problem body, and every route needs the cookie except the signed media link and the rain state', () => {
    for (const [path, ops] of Object.entries(spec.paths).filter(([p]) => CHAT_PATH(p))) {
      for (const [method, op] of Object.entries(ops).filter(([m]) => VERBS.includes(m))) {
        const json = JSON.stringify(op.responses['500']);
        expect(json, `${method} ${path} 500`).toContain('#/components/schemas/Problem');
        // The rain state is public: the Rainpool countdown is shown on the dashboard before sign-in.
        const open = path.endsWith('/media/{mediaId}') || path === '/social/rain/state';
        expect(JSON.stringify(op.security), `${method} ${path} security`).toBe(
          open ? '[]' : JSON.stringify([{ SessionCookie: [], CsrfHeader: [] }]),
        );
      }
    }
  });

  it('declares the cookie and CSRF schemes and no bearer scheme for chat', () => {
    expect(spec.components.securitySchemes.SessionCookie).toBeDefined();
    expect(spec.components.securitySchemes.CsrfHeader).toBeDefined();
    expect(
      JSON.stringify(
        Object.entries(spec.paths).filter(([p]) => p.startsWith('/social/chat')),
      ).includes('BearerAuth'),
    ).toBe(false);
  });
});

describe('the chat Postman collection', () => {
  it.each(routes.map((r) => [`${r.method.toUpperCase()} ${r.path}`] as const))(
    'has a request for %s',
    (label) => {
      expect(
        requests.some((r) => r.name.startsWith(`${label} `)),
        `no request "${label}"`,
      ).toBe(true);
    },
  );

  it('signs in with the cookie first and has one status test per request', () => {
    expect(collection.item[0]!.name).toMatch(/Sign in/);
    for (const request of requests) {
      const script = JSON.stringify(request.event?.[0]?.script.exec ?? []);
      expect(script, request.name).toContain('status is');
    }
  });

  it('uses the user backend port', () => {
    expect(
      readFileSync(join(ROOT, 'docs', 'postman', 'orebit-chat.postman_collection.json'), 'utf8'),
    ).toContain('http://localhost:3005');
  });
});
