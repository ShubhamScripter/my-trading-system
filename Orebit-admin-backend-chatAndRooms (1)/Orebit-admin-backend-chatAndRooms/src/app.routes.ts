import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/security/guards';
import { AppService, type HealthResponse, type ReadinessResponse } from './app.service';
import { ok, type SuccessEnvelope } from './http';

/**
 * Root routes. Declarative and logic-free, like every other `*.routes.ts` —
 * they extract what the framework can extract and delegate.
 *
 * `@Public()` on the class: both routes are probes, and a load balancer or an
 * orchestrator has no credential to offer. A readiness check that could return 401
 * would take the service out of rotation for being healthy.
 *
 * Note what these deliberately do NOT report: no version, no commit SHA, no
 * dependency versions. This service administers the platform, so an
 * unauthenticated endpoint should not hand an attacker a list of what to look up
 * CVEs for. `env` is the one exception, and it is there because "am I pointed at
 * production" is the question this endpoint gets asked most.
 */
@Public()
@Controller()
export class AppRoutes {
  constructor(private readonly service: AppService) {}

  @Get('health')
  health(): SuccessEnvelope<HealthResponse> {
    return ok(this.service.health());
  }

  @Get('readiness')
  async readiness(): Promise<SuccessEnvelope<ReadinessResponse>> {
    return ok(await this.service.readiness());
  }
}

/**
 * The route-group registry: every URL prefix this service answers on, and the
 * module that owns it.
 *
 * Nest derives routing from `@Controller` decorators, so this table does not
 * *drive* anything — it is documentation that a test asserts against
 * (tests/app.routes.spec.ts), which is the closest thing to a mechanical check
 * available without a dependency-graph linter. Add a module, add a row.
 */
export const ROUTE_GROUPS = [
  { prefix: '', module: 'app', description: 'health and readiness' },
  {
    prefix: 'auth',
    module: 'auth',
    description: 'sign-in ceremony, sessions, current admin',
  },
  {
    prefix: '2fa',
    module: 'src/2fa',
    description: 'second-factor management for a signed-in admin',
  },
  {
    prefix: 'captcha',
    module: 'src/captcha',
    // Configuration, not part of signing in — the anonymous read a login page makes
    // is `POST /auth/login {"step":"start"}`. Super-admin only, and the write is
    // elevated: turning a provider off weakens an unauthenticated defence.
    description: 'super-admin control over which captcha providers are offered',
  },
  {
    prefix: 'security-policies',
    module: 'src/security-policies',
    // Configuration, not an action on any account. Super-admin only, and the write is
    // elevated: a policy decides what happens to every user after a sensitive change.
    description:
      'super-admin control over the temporary feature restrictions applied after a ' +
      'sensitive user security action',
  },
  {
    prefix: 'admins',
    module: 'src/admins',
    // The only prefix whose actions target an account other than the caller's own.
    description:
      'super-admin actions on other admins: factor recovery, disable, enable, ' +
      'and the login-review queue',
  },
  {
    prefix: 'kyc-policies',
    module: 'src/kyc',
    // Configuration, not an action on any account. Written here and READ by
    // ../Orebit-backend's KYC evaluator straight out of the shared `identity` schema;
    // there is no API between the two services. Super-admin only, and every write is
    // elevated: a policy decides who must verify before they can use the platform.
    description:
      'super-admin control over which accounts must complete identity verification, ' +
      'where, at what level, and on what trigger',
  },
  {
    prefix: 'kyc-renewal',
    module: 'src/kyc',
    // The two GLOBAL numbers that decide when a completed verification goes stale:
    // X, after which re-verification is mandatory, and Y, after which a holder may
    // redo a level voluntarily. Written here and READ by ../Orebit-backend on every
    // KYC evaluation, straight out of the shared `identity` schema; there is no API
    // between the two services.
    //
    // Deliberately NOT per region or per level — unlike `kyc-policies`, whose key is
    // (region, level). A single row, and a route shape that cannot express a narrower
    // one.
    //
    // The sharpest write on the KYC surface: both periods ship NULL, meaning nothing
    // ever expires, and the first mandatory period set here invalidates every account
    // whose verification predates it, simultaneously and with no grace period. The
    // writer counts them and records the count on its audit event.
    //
    // Two routes only. The configuration is two nullable numbers and keeps no history
    // of itself — no version, no reason, no previous values. Who changed it is
    // KYC_RENEWAL_SETTINGS_UPDATED in the admin audit log, read through that surface.
    description:
      'super-admin control over the global KYC renewal periods — how long a completed ' +
      'verification stays valid, and when its holder may redo it voluntarily',
  },
  {
    prefix: 'kyc-history',
    module: 'src/kyc',
    // READ-ONLY. Two GETs over `identity.kyc_verifications`, the permanent record of
    // every KYC attempt an account has ever made — including the successes a later
    // renewal replaced. There is no write handler, no mutating statement behind it, and
    // no way to approve a case or manufacture a result from here: a decision is the
    // provider's and arrives over a signed webhook in ../Orebit-backend.
    //
    // Sealed document numbers and names are absent from the projection, as is the raw
    // webhook payload. Every read is audited.
    description:
      'super-admin read-only view of every KYC verification attempt, with the devices ' +
      'and provider deliveries behind one attempt',
  },
  {
    prefix: 'kyc-requirements',
    module: 'src/kyc',
    // The MIRROR of kyc-exemptions, pointing the other way: an exemption relieves one
    // account of a KYC obligation, this imposes one on it. Writes
    // `identity.kyc_requirements`, which the consumer evaluates on every KYC decision
    // and closes when an approved verification discharges the row.
    //
    // It is the safer of the two per-account KYC writes — an obligation only ever
    // WITHHOLDS standing, and this surface has no statement that could touch a
    // verification, a level state or a provider event. It also decides nothing about
    // whether the obligation currently bites: that is the consumer's evaluator, and
    // the validity algorithm behind it is deliberately not duplicated here.
    description:
      'super-admin imposition and waiver of manual KYC obligations against one account',
  },
  {
    prefix: 'kyc-entitlements',
    module: 'src/kyc',
    // What each KYC LEVEL grants, as opposed to whether a level is required. Writes
    // `identity.kyc_level_entitlements` (the feature matrix and the three account
    // ceilings, one row per level including NONE) and
    // `identity.kyc_upgrade_requirements` (what it takes to become eligible to reach
    // L1 or L2).
    //
    // Its own prefix rather than fields on kyc-policies, because that table is keyed
    // `(region, level)` and an entitlement is GLOBAL — storing a platform-wide ceiling
    // on one row per country would give it as many authorities as there are countries.
    // The same argument that moved the renewal periods onto their own table.
    //
    // It targets a RULE and never an account: there is no `userId` anywhere on this
    // surface, and no statement here touches a verification, a level state, an
    // exemption or a requirement. It also cannot grant an upgrade achievement — that
    // is an observation of a balance, and only the consumer holding the account-data
    // port can make one.
    description:
      'super-admin configuration of what each KYC level grants — the feature matrix, ' +
      'the account limits, and the balance and deposit routes to the next level',
  },
  {
    prefix: 'countries',
    module: 'src/country',
    // TWO surfaces under one prefix, and they are not interchangeable:
    //
    //   GET/POST /countries/images  the IMAGE LIBRARY — objects in the R2 bucket. An
    //                               asset may be used by many countries or by none, and
    //                               an upload creates NO row. Reads storage only.
    //   GET/POST /countries         the CATALOGUE — rows in `admin.countries`, each
    //                               holding the two object keys an admin chose. Reads
    //                               the database only.
    //
    // Reference data, not an action on any account — there is no `userId` anywhere on
    // this surface. Super-admin only, and the writes are NOT elevated: see the block in
    // country.routes.ts for what that costs and how to restore it.
    //
    // Uploads land at `country-assets/{ISO}/{type}/{uuid}.webp`, so a new image never
    // overwrites one an existing country still points at. A client supplies a KEY and
    // never a URL, and a key is refused unless it parses as one of ours AND names an
    // object that is really there.
    //
    // Written here and intended to be READ by ../Orebit-backend straight out of the
    // shared `admin` schema, the way it already reads admin_captcha_providers; there is
    // no API between the two services.
    description:
      'super-admin management of the country catalogue and the flag-image library — ' +
      'browse or upload images in object storage, then create countries from them',
  },
  {
    prefix: 'kyc-exemptions',
    module: 'src/kyc',
    // The second prefix whose actions target an account other than the caller's own,
    // and the more dangerous of the two: a live exemption raises that account's
    // EFFECTIVE verification level platform-wide, with no provider attesting anything.
    description:
      'super-admin grants of administrative relief from a KYC obligation, and the ' +
      'withdrawal of them',
  },
  {
    prefix: 'social/chat',
    module: 'src/social',
    description:
      'social chat room lifecycle, access controls, moderation reports, cosmetics, and alerts',
  },
] as const;
