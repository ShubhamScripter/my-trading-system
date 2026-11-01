import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatRoutes } from '../../src/social/chat/chat.routes';
import { ChatModulesRoutes } from '../../src/social/chat/chat.modules.routes';
import { ChatReportStatsRoutes } from '../../src/social/chat/chat-report-stats.routes';
import { RainAdminRoutes } from '../../src/social/rain/rain-admin.routes';

/** The admin chat documents match the admin chat routes: openapi.json and the chat Postman collection. */
const ROOT = join(__dirname, '..', '..');
const spec = JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};
const collection = JSON.parse(
  readFileSync(join(ROOT, 'docs', 'Orebit_Admin_Chat.postman_collection.json'), 'utf8'),
) as { item: { item: { name: string; event: { script: { exec: string[] } }[] }[] }[] };
const requests = collection.item.flatMap((folder) => folder.item);

/** Modules 1–3 (ChatRoutes), Modules 4–9 (ChatModulesRoutes) and RainPool, Modules 6–7 (RainAdminRoutes). */
const routes = [ChatRoutes, ChatModulesRoutes, ChatReportStatsRoutes, RainAdminRoutes].flatMap((cls) => {
  const proto = cls.prototype as unknown as Record<string, unknown>;
  const base = Reflect.getMetadata('path', cls) as string;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name] as object;
    const path = Reflect.getMetadata('path', handler) as string | undefined;
    const method = Reflect.getMetadata('method', handler) as number | undefined;
    if (path === undefined || method === undefined) return [];
    return [{ method: ['get', 'post'][method]!, path: `/${base}/${path}` }];
  });
});
const CHAT_PATH = (path: string) => path.startsWith('/social/chat') || path.startsWith('/social/rain');

describe('openapi.json chat section', () => {
  it('finds the chat and rain routes', () => expect(routes.length).toBe(85));

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
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`))
      .filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });
});

describe('the admin chat Postman collection', () => {
  it.each(routes.map((r) => [`${r.method.toUpperCase()} ${r.path}`] as const))(
    'has a request for %s',
    (label) => {
      expect(
        requests.some((r) => r.name.startsWith(`${label} `)),
        `no request "${label}"`,
      ).toBe(true);
    },
  );

  it('has one status test per request and uses the admin port', () => {
    for (const request of requests)
      expect(JSON.stringify(request.event[0]!.script.exec), request.name).toContain('status is');
    expect(JSON.stringify(collection)).toContain('http://localhost:3002');
  });
});
