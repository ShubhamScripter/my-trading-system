import { Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import {
  captchaToggleRequestSchema,
  toCaptchaProvidersPayload,
  type CaptchaProvidersPayload,
} from './captcha.dto';
import { CaptchaSettingsService, PROPAGATION_SECONDS } from './captcha.settings';

/**
 * Parse, delegate, serialise. No business logic and — unusually for this service —
 * no authorisation either.
 *
 * ═══ WHY THE GATE IS ON THE ROUTE AND NOT IN HERE ══════════════════════════
 *
 * `AdminsController` does its own authorisation because what it must check depends
 * on the body — which admin is being targeted, and whether that is the caller. This
 * route targets no admin, so the gate is the same for every caller and can be
 * DECLARED: `@UseGuards(SuperAdminGuard)` on the handler.
 *
 * The benefit is that "who may call this" is answerable by reading the route file,
 * with no need to trust that a controller remembered to check. The cost is that a
 * deleted decorator is silent, which is why captcha-toggle.spec.ts asserts the
 * guards — including asserting that no elevation guard is present, so the dropped
 * requirement cannot drift back in unnoticed.
 */
@Injectable()
export class CaptchaAdminController {
  constructor(private readonly settings: CaptchaSettingsService) {}

  /** Every provider and why it is or is not live. Reads the table, not the cached
   *  snapshot — see `CaptchaSettingsService.state`. */
  async list(): Promise<SuccessEnvelope<CaptchaProvidersPayload>> {
    return ok(toCaptchaProvidersPayload(await this.settings.state(), PROPAGATION_SECONDS));
  }

  /**
   * Switch one provider on or off, and return the whole table as it now stands.
   *
   * The full list rather than the one changed row, deliberately: the interesting
   * question after a toggle is "what is live NOW", and answering it here means a
   * screen does not have to follow every write with a read — nor risk rendering a
   * stale list beside a fresh success message.
   */
  async toggle(body: unknown, actor: Principal): Promise<SuccessEnvelope<CaptchaProvidersPayload>> {
    const input = parseDto(captchaToggleRequestSchema, body);

    const state = await this.settings.toggle({
      provider: input.provider,
      enabled: input.enabled,
      reason: input.reason ?? null,
      // From the authenticated principal, never from the body. An actor a caller
      // could name would make the audit column worse than useless.
      actorAdminId: actor.adminId,
    });

    return ok(toCaptchaProvidersPayload(state, PROPAGATION_SECONDS));
  }
}
