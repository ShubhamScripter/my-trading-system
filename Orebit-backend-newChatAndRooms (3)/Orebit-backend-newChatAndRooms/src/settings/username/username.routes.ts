import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { requirePrincipal } from '../../../auth/security/guards';
import type { SuccessEnvelope } from '../../http';
import { UsernameController } from './username.controller';
import type {
  UsernameAvailabilityPayload,
  UsernameStatusPayload,
  UsernameUpdatedPayload,
} from './username.dto';

/**
 * The route table for the username setting. Declarative, zero logic.
 *
 * The fourth class to declare `@Controller('settings')` — Nest merges them onto one
 * prefix, and the split is containment: every line of this feature lives in its own
 * directory so it reads, reviews and removes as one unit. Like the other three, this
 * class is listed in `tests/auth/openapi.drift.spec.ts`, which is what stops a route on
 * an EXISTING prefix from shipping undocumented.
 *
 * ─── `profile/` rather than `security/` ─────────────────────────────────────
 *
 * Every other settings route in this module sits under `security/`, and this one
 * deliberately does not. The distinction is not filing: `SECURITY_COOLDOWN` freezes
 * `settings/security/*` after an email change, and the set it freezes — the second
 * factors, the recovery codes, the Payment PIN, the password — is documented as closed
 * and is exactly the set of things that authenticate a person. A username authenticates
 * nobody; it is a public identifier, alongside the country and avatar that
 * `updateMyProfile` already changes without any freeze.
 *
 * So the path says which kind of setting this is, and the absence of a cooldown check
 * in `UsernameService` is consistent with it rather than an omission. What protects the
 * released username instead is the reservation: after a takeover the owner's previous
 * name is held for them, and reclaiming it is free even with the allowance spent — see
 * `isProtectedReservation`. That protects the same asset without freezing the owner out
 * of their own remediation, which is the argument `SECURITY_COOLDOWN` itself makes for
 * being twenty-four hours rather than thirty days.
 *
 * ─── Why three routes and not one with an action ────────────────────────────
 *
 * They are three different things: a read, a read that is called on a keystroke
 * debounce, and a write that moves an identity. The middle one is why it matters —
 * `GET .../check` has to be a GET with a query parameter so it is cacheable, cancelable
 * by the browser when the user types on, and cheap. Folding it into the POST body would
 * make every keystroke a write-shaped request.
 *
 * ─── Why none of these is `@Public()` ───────────────────────────────────────
 *
 * All three read or change the caller's own account, and the availability check is
 * metered per account. The global `AuthGuard` covers them, and their absence from this
 * file is the statement — `@Public()` is opt-out and fails closed.
 *
 * `'settings'` here must match the `settings` entry in ROUTE_GROUPS (src/app.routes.ts).
 */
@Controller('settings')
export class UsernameRoutes {
  constructor(private readonly controller: UsernameController) {}

  @Get('profile/username')
  status(@Req() req: FastifyRequest): Promise<SuccessEnvelope<UsernameStatusPayload>> {
    return this.controller.status(requirePrincipal(req));
  }

  @Get('profile/username/check')
  check(
    @Query() query: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<UsernameAvailabilityPayload>> {
    return this.controller.check(query, requirePrincipal(req));
  }

  @Post('profile/username')
  update(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<UsernameUpdatedPayload>> {
    return this.controller.update(body, requirePrincipal(req));
  }
}
