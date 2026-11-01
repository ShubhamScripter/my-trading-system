import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { OpenAPIV3 } from 'openapi-types';
import { config } from './config';

/**
 * The browsable API reference, served at /docs.
 *
 * ─── Why the document is a file rather than decorators ─────────────────────
 *
 * The usual NestJS route is `@nestjs/swagger`, which builds the document by
 * reading `class-validator` / `@ApiProperty` decorators off DTO classes. This
 * service has neither: validation is Zod, applied by hand in the controller, and
 * every handler takes `@Body() body: unknown`. Decorator introspection would find
 * three `POST` routes with no describable body and produce a document that is
 * worse than no document at all.
 *
 * So `openapi.json` at the repo root is the source, and this module only serves
 * it. That also keeps one artifact for every consumer — the UI below, client
 * generators, and contract tests all read the same bytes.
 *
 * The trade is that the file does not update itself when a DTO changes. It is a
 * checked-in artifact with the same maintenance burden as a README, and the same
 * failure mode if nobody touches it.
 *
 * ─── Why serving it never blocks boot ──────────────────────────────────────
 *
 * A missing or malformed document logs and skips. Documentation is not a
 * dependency of authentication, and refusing to start the service because a docs
 * file was not copied into an image would be an own goal.
 */

const DOCS_ROUTE = '/docs';
const SPEC_FILE = 'openapi.json';

const logger = new Logger('OpenAPI');

/**
 * Where the document lives, tried in order.
 *
 * `process.cwd()` covers both real entry points — `npm run dev` and
 * `node dist/src/main.js` are both invoked from the repo root — and the
 * `__dirname`-relative candidates cover a process started from somewhere else.
 * `tsc` does not copy JSON into `dist`, which is why none of these look inside it.
 */
function specCandidates(): readonly string[] {
  return [
    resolve(process.cwd(), SPEC_FILE),
    resolve(__dirname, '..', SPEC_FILE),
    resolve(__dirname, '..', '..', SPEC_FILE),
  ];
}

function loadSpec(): OpenAPIV3.Document | null {
  for (const path of specCandidates()) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue; // not here; try the next candidate
    }
    try {
      return JSON.parse(raw) as OpenAPIV3.Document;
    } catch (err) {
      // Found but unreadable is a different problem from absent, and silently
      // falling through to the next candidate would hide a corrupted file.
      logger.error({ path, err }, 'openapi.json is not valid JSON; /docs disabled');
      return null;
    }
  }
  logger.warn({ tried: specCandidates() }, 'openapi.json not found; /docs disabled');
  return null;
}

/**
 * Mount the reference. A no-op when docs are disabled or the document is absent.
 *
 * These routes are registered on the Fastify instance rather than through a Nest
 * controller, so the global `AuthGuard` never sees them — which is what we want (a
 * login page for the login docs is a circular problem) and worth stating plainly,
 * because "public" here is a consequence of the registration mechanism rather than
 * of a `@Public()` decorator someone can grep for.
 *
 * `config.docsEnabled` defaults to off in production for a reason that applies
 * doubly to this service: a full description of an admin authentication API is a
 * map of its doors.
 */
export async function registerOpenApi(app: NestFastifyApplication): Promise<void> {
  if (!config.docsEnabled) {
    logger.log('docs are disabled; /docs not mounted');
    return;
  }

  const document = loadSpec();
  if (document === null) return;

  await app.register(import('@fastify/swagger'), {
    mode: 'static',
    specification: { document },
  });

  await app.register(import('@fastify/swagger-ui'), {
    routePrefix: DOCS_ROUTE,
    uiConfig: {
      // The sign-in route alone carries nine request shapes. Expanded, the page
      // opens as a wall of schemas; collapsed, the reader sees the operations
      // first and drills in.
      docExpansion: 'list',
      deepLinking: true,
      // Sort by the order in the document, not alphabetically — the sign-in steps
      // are a sequence and alphabetising them is actively misleading.
      operationsSorter: undefined,
      persistAuthorization: true,
    },
    // The plugin sets its own CSP on these routes; helmet's defaults are what
    // actually govern, but leaving this on costs nothing.
    staticCSP: true,
  });

  logger.log({ url: `http://localhost:${config.PORT}${DOCS_ROUTE}` }, 'API reference mounted');
}
