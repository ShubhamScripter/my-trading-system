import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import { requirePrincipal, SuperAdminGuard } from '../../auth/security/guards';
import { ElevationGuard, RequiresElevation } from '../2fa/elevation';
import type { SuccessEnvelope } from '../http';
import { SecurityPolicyController } from './security-policies.controller';
import type { SecurityPoliciesPayload } from './security-policies.dto';
import { SECURITY_POLICY_ELEVATION } from './security-policies.types';

/**
 * THE route table for the `security-policies` prefix. Declarative, zero logic.
 *
 * ─── Why a prefix of its own ───────────────────────────────────────────────
 *
 * Not under `/admins`, because every action there names an `adminId` and that
 * invariant is worth keeping true — it is what makes "what can touch another admin" a
 * question you answer by reading one file. A policy targets no admin.
 *
 * Not under `/auth`, because everything there is part of signing in and this is
 * configuration. The same two arguments `CaptchaRoutes` makes for its own prefix.
 *
 * ─── NOT `@Public()` ───────────────────────────────────────────────────────
 *
 * The global `AuthGuard` in src/app.module.ts covers both handlers and this file says
 * nothing about it. Its silence is the statement.
 *
 * `'security-policies'` here must match the entry in ROUTE_GROUPS (src/app.routes.ts).
 */
@Controller('security-policies')
export class SecurityPolicyRoutes {
  constructor(private readonly controller: SecurityPolicyController) {}

  /**
   * Every policy, and the vocabulary to render one.
   *
   * SUPER_ADMIN, but NO elevation ticket: this changes nothing, and demanding a fresh
   * factor proof to look at a settings screen would train operators to keep a ticket in
   * hand — exactly the habit a single-use ticket exists to prevent. Same reasoning as
   * `GET /captcha/providers` and `GET /admins/login-reviews`.
   *
   * A GET, so it is cacheable, linkable and safe to retry.
   */
  @Get()
  @UseGuards(SuperAdminGuard)
  list(): Promise<SuccessEnvelope<SecurityPoliciesPayload>> {
    return this.controller.list();
  }

  /**
   * Create or update one policy.
   *
   * ─── Elevation IS required here, unlike the captcha toggle ────────────────
   *
   * That route carried these two decorators and had them removed, on the argument that
   * an operator switching a captcha provider off is usually responding to a vendor
   * incident and should not have to re-prove a factor mid-incident. Recorded there so
   * the absence reads as a decision.
   *
   * The argument does not transfer. A security-restriction policy is not an incident
   * lever — there is no outage it is the remedy for — and weakening one weakens
   * protection for every platform user on every sensitive action from then on. So a
   * stolen or hijacked super-admin session must not be able to make this write on its
   * own, which is precisely what the ticket prevents.
   *
   * `@RequiresElevation` names ONE action, and a single-purpose route is the normal
   * case for the guard — `POST /admins` is the union-body exception that spends its
   * ticket in the controller instead.
   */
  @Post()
  @UseGuards(SuperAdminGuard, ElevationGuard)
  @RequiresElevation(SECURITY_POLICY_ELEVATION)
  upsert(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<SecurityPoliciesPayload>> {
    return this.controller.upsert(
      body,
      requirePrincipal(req),
      // Built here rather than in the controller, as every other route does it: the
      // request object stops at this layer, so the controller stays testable without a
      // live HTTP request. The policy write records an auth event, and an audit row
      // with no idea where the action came from is half a row.
      clientContextOf(
        req.ip,
        headerValue(req.headers['user-agent']),
        headerValue(req.headers['accept-language']),
      ),
    );
  }
}
