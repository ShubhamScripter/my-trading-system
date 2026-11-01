import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ipClassOf } from '../../../auth/auth.utility';
import { requestFactsOf } from '../../restrictions/restrictions.service';
import {
  OptionalAuthGuard,
  Public,
  optionalPrincipal,
  requirePrincipal,
} from '../../../auth/security/guards';
import type { SuccessEnvelope } from '../../http';
import { EmailChangeController } from './email.controller';
import type {
  EmailChangeStartedPayload,
  EmailChangedPayload,
  EmailCodeResentPayload,
  EmailRecoveredPayload,
  EmailRecoveryStartedPayload,
  EmailStatusPayload,
} from './email.dto';

/**
 * THE route table for changing the account's email. Declarative, zero logic.
 *
 * Three routes, and the whole feature: read the setting, start a change, complete one.
 * The recovery ceremony rides the same two POSTs on its own `action` and its own body
 * shape rather than claiming routes of its own — it is the same feature seen from the
 * other side, and giving it a separate path would publish two APIs describing one
 * lifecycle.
 *
 * ─── Why two of these are `@Public()`, which is the decision to scrutinise ───
 *
 * Every other route in `src/settings/` needs a session, and their absence from any
 * `@Public()` list is the statement. These two are the exception, deliberately.
 *
 * A completed email change sweeps every session — the address that authenticated them is
 * no longer the account's — and the released address cannot sign in, because a retained
 * address is not a login credential. So the person who most needs the recovery flow is
 * exactly the person who cannot authenticate: somebody whose account was moved to an
 * address they do not control. Requiring a session here would close the flow for its
 * only real user.
 *
 * What stands in for the session is a server-minted, single-use ticket mailed to the
 * released address, plus a fresh code to that same address. That is a stronger proof of
 * "this mailbox" than a bearer token is, and it is the only thing these routes accept
 * without one.
 *
 * `@Public()` + `OptionalAuthGuard` is an existing combination, not a new one — see
 * `POST /auth/session` in auth/auth.routes.ts, which is public for a comparable reason
 * (its credential is a cookie rather than a bearer). The guard still resolves and
 * attaches a principal when a token IS present, so the authenticated branches are
 * unaffected; and `SafetyNetGuard` still meters these routes per IP, which is what
 * bounds an unauthenticated caller.
 *
 * ─── Where the authentication actually happens ──────────────────────────────
 *
 * In `EmailChangeController`, per branch, and nowhere else. Every non-recovery action
 * passes its principal through `requireCaller`, which refuses a null. That is the line
 * this arrangement lives or dies by, and it is tested directly — see the public-route
 * suite in the spec.
 *
 * The GET is NOT public: it reports the account's own state, needs a principal to have
 * any meaning, and nothing in the recovery flow reads it. The client rendering a
 * recovery screen has the ticket from the email and needs nothing else.
 *
 * `'settings'` here must match the `settings` entry in ROUTE_GROUPS (src/app.routes.ts).
 * This is the third `@Controller('settings')` class, beside `SettingsRoutes` and
 * `PaymentPinRoutes`; each keeps its feature whole in one directory. All three are
 * listed in `tests/auth/openapi.drift.spec.ts`, which is what stops a route shipping
 * undocumented.
 */
@Controller('settings')
export class EmailChangeRoutes {
  constructor(private readonly controller: EmailChangeController) {}

  @Get('security/email')
  status(@Req() req: FastifyRequest): Promise<SuccessEnvelope<EmailStatusPayload>> {
    return this.controller.status(requirePrincipal(req));
  }

  @Public()
  @UseGuards(OptionalAuthGuard)
  @Post('security/email')
  mutate(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<
    SuccessEnvelope<
      EmailChangeStartedPayload | EmailCodeResentPayload | EmailRecoveryStartedPayload
    >
  > {
    // `req.ip` in full for the challenge row, which records where a code was requested
    // from, and for the per-network recovery bucket. `ipClassOf` alongside it for the
    // notifications — a /24 is enough for "not where I live" and does not put a precise
    // address in somebody's inbox. Both derived here so the handler stays the only thing
    // that touches the request, and neither via `contextOf`, which would issue a device
    // cookie as a side effect of being read.
    return this.controller.mutate(
      body,
      optionalPrincipal(req),
      req.ip,
      ipClassOf(req.ip),
    );
  }

  @Public()
  @UseGuards(OptionalAuthGuard)
  @Post('security/email/verify')
  verify(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<EmailChangedPayload | EmailRecoveredPayload>> {
    return this.controller.verify(
      body,
      optionalPrincipal(req),
      req.ip,
      requestFactsOf(req),
    );
  }
}
