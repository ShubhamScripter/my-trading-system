import { Injectable } from '@nestjs/common';
import type { Principal } from '../../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../../http';
import {
  antiPhishingRequestSchema,
  type AntiPhishingStatusPayload,
  type AntiPhishingUpdatedPayload,
} from './antiPhishing.dto';
import { AntiPhishingService } from './antiPhishing.service';

/**
 * Parse, delegate, serialise. No policy lives here.
 *
 * Every handler takes the acting account from the `Principal` and never from the body,
 * so a caller can only ever change their own code — the property `PasswordController`
 * and `PaymentPinController` rely on, and the reason no action carries a user id. There
 * is no code path in this file, the DTOs, or the service that reads an account
 * identifier out of a request.
 */
@Injectable()
export class AntiPhishingController {
  constructor(private readonly antiPhishing: AntiPhishingService) {}

  async status(principal: Principal): Promise<SuccessEnvelope<AntiPhishingStatusPayload>> {
    const status = await this.antiPhishing.status(principal.userId);
    return ok({ outcome: 'anti_phishing_code_status', ...status });
  }

  /**
   * The three operations, on one `action` field.
   *
   * ─── The switch is the whole of the dispatch, and it is exhaustive ─────────
   *
   * `never` in the default arm means adding a member to `antiPhishingRequestSchema`
   * without handling it fails the build. That matters more here than in most
   * controllers: an unhandled action would fall through to a returned `undefined`
   * rather than a refusal, which is a 200 for a write that never happened.
   *
   * ─── `action` is echoed from the SERVER's dispatch ─────────────────────────
   *
   * Read off the arm that actually ran rather than copied from `input`, so an
   * integration bug surfaces as a mismatch rather than as a confident wrong label — the
   * property `PasswordChangedPayload.operation` relies on.
   *
   * ─── `otherSessionsRevoked: false` on all three ───────────────────────────
   *
   * Stated rather than left for the client to infer, per `BiometricsDisabledPayload`,
   * and false because no session was ever established with an anti-phishing code. See
   * `AntiPhishingService.finish` for why a sweep would address nothing.
   *
   * ─── No code in any response ──────────────────────────────────────────────
   *
   * None of the three arms returns the value that was written. The user sees it in their
   * next email, which is the channel this feature is about.
   */
  async mutate(
    body: unknown,
    principal: Principal,
    ipClass: string,
  ): Promise<SuccessEnvelope<AntiPhishingUpdatedPayload>> {
    const input = parseDto(antiPhishingRequestSchema, body);

    switch (input.action) {
      case 'set': {
        await this.antiPhishing.set(principal, ipClass, input);
        return ok({
          outcome: 'anti_phishing_code_updated',
          action: 'set',
          otherSessionsRevoked: false,
        });
      }

      case 'change': {
        await this.antiPhishing.change(principal, ipClass, input);
        return ok({
          outcome: 'anti_phishing_code_updated',
          action: 'change',
          otherSessionsRevoked: false,
        });
      }

      case 'replace': {
        await this.antiPhishing.replace(principal, ipClass, input);
        return ok({
          outcome: 'anti_phishing_code_updated',
          action: 'replace',
          otherSessionsRevoked: false,
        });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }
}
