import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import { requirePrincipal, SuperAdminGuard } from '../../auth/security/guards';
import type { SuccessEnvelope } from '../http';
import { CountryController } from './country.controller';
import type { CountriesPayload, CountryImagesPayload } from './country.dto';
import { readCountryImageMultipart } from './country.multipart';
import type { CountryImageAsset, CountryView } from './country.types';

/**
 * THE route table for the `countries` prefix. Declarative, zero logic.
 *
 * ═══ TWO SURFACES THAT MUST NOT BE CONFUSED ════════════════════════════════
 *
 *   /countries/images   the IMAGE LIBRARY. Objects in the R2 bucket. An asset here may
 *                       be used by many countries, or by none. Reads storage only.
 *   /countries          the CATALOGUE. Rows in `admin.countries`. Reads the database
 *                       only.
 *
 * They answer different questions — "which flags can I choose from" versus "which
 * countries exist" — and an asset is emphatically not a country. Merging them would make
 * an unused upload look like a country that exists.
 *
 * ─── NO PATH PARAMETERS ───────────────────────────────────────────────────
 *
 * The ISO code travels in the body, a multipart field, or the query string, never in the
 * path. `tests/app.routes.spec.ts` asserts this across every controller in the service
 * and states the reason: a path parameter naming the target spreads "what can this
 * reach" across every route's decorator instead of keeping it in one validated field
 * checked in one place.
 *
 * ─── NOT `@Public()` ──────────────────────────────────────────────────────
 *
 * The global `AuthGuard` in src/app.module.ts covers all four handlers and this file
 * says nothing about it. Its silence is the statement.
 *
 * `'countries'` here must match the entry in ROUTE_GROUPS (src/app.routes.ts).
 */
@Controller('countries')
export class CountryRoutes {
  constructor(private readonly controller: CountryController) {}

  /**
   * The image library: every country image in the bucket, newest first.
   *
   * This is what the Create Country screen calls so an admin can pick an existing flag
   * instead of uploading one. `?isoCode=` and `?type=` narrow it.
   *
   * Returns ASSET METADATA — key, url, type, iso, size — and deliberately no country
   * name: an object in a bucket is not a country record, and manufacturing a name from a
   * key would invent a fact storage does not have.
   *
   * SUPER_ADMIN, but no elevation ticket: it changes nothing, and demanding a fresh
   * factor proof to look at a picker would train operators to keep a ticket in hand —
   * the habit a single-use ticket exists to prevent.
   */
  @Get('images')
  @UseGuards(SuperAdminGuard)
  listImages(@Query() query: unknown): Promise<SuccessEnvelope<CountryImagesPayload>> {
    return this.controller.listImages(query);
  }

  /**
   * The catalogue: every country with both image URLs, or one when `?isoCode=` narrows it.
   *
   * Reads `admin.countries` and never the bucket. A country appears here only once it has
   * been created, which an upload alone does not do.
   */
  @Get()
  @UseGuards(SuperAdminGuard)
  list(@Query() query: unknown): Promise<SuccessEnvelope<CountriesPayload>> {
    return this.controller.list(query);
  }

  /**
   * ═══ NO ELEVATION CHECK — DEFERRED, NOT OVERLOOKED ═════════════════════════
   *
   * Both writes below are SUPER_ADMIN-gated and neither demands an elevation ticket,
   * matching the whole KYC surface rather than `security-policies`.
   *
   * What that costs: an attacker holding a live super-admin session can add a country or
   * put a new image in the library without proving a second factor. The blast radius is
   * bounded — this surface cannot touch an account, a balance, a policy or a
   * verification, it cannot overwrite or delete an existing asset, and the worst outcome
   * is an unwanted image sitting in a picker until it is ignored. Both actions are
   * attributed in the audit log.
   *
   * To restore it, add `TwoFactorModule` to the module's imports and to each write:
   *
   *     @UseGuards(SuperAdminGuard, ElevationGuard)
   *     @RequiresElevation(COUNTRY_ELEVATION.create)   // and .uploadImage
   *
   * declaring the action names in country.types.ts as the other surfaces do — one per
   * action (`admin.country.create`, `admin.country.image.upload`), never a shared
   * `admin.write`.
   */
  @Post()
  @UseGuards(SuperAdminGuard)
  create(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<CountryView>> {
    return this.controller.create(
      body,
      requirePrincipal(req),
      // Built here rather than in the controller, as every other route does it: the
      // request object stops at this layer, so the controller stays testable without a
      // live HTTP request. The write records an auth event, and an audit row with no
      // idea where the action came from is half a row.
      clientContextOf(
        req.ip,
        headerValue(req.headers['user-agent']),
        headerValue(req.headers['accept-language']),
      ),
    );
  }

  /**
   * Puts ONE image into the library and returns its key and public URL.
   *
   * Creates NO country and requires none to exist — the returned key is what the client
   * hands to `POST /countries` afterwards, and the returned URL is what it renders as a
   * preview in the meantime. An upload that is never followed by a create leaves an
   * asset in the library for the next admin to select, which is the feature working.
   */
  @Post('images')
  @UseGuards(SuperAdminGuard)
  async uploadImage(@Req() req: FastifyRequest): Promise<SuccessEnvelope<CountryImageAsset>> {
    const principal = requirePrincipal(req);
    const client = clientContextOf(
      req.ip,
      headerValue(req.headers['user-agent']),
      headerValue(req.headers['accept-language']),
    );

    // The one handler that reads the request body itself: there is no `@Body()` for a
    // multipart stream, and the parts must be drained before anything can be validated.
    // Isolated in country.multipart.ts so this layer stays a route table.
    const upload = await readCountryImageMultipart(
      req as Parameters<typeof readCountryImageMultipart>[0],
    );

    return this.controller.uploadImage(upload, principal, client);
  }
}
