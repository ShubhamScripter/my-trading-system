import { Injectable } from '@nestjs/common';
import type { Principal } from '../../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../../http';
import type { RequestFacts } from '../../restrictions/restrictions.types';
import {
  passwordRequestSchema,
  type PasswordChangedPayload,
  type PasswordStatusPayload,
} from './password.dto';
import { PasswordSettingsService } from './password.service';

/**
 * Parse, delegate, serialise. No policy lives here.
 *
 * Every handler takes the acting account from the `Principal` and never from the
 * body, so a caller can only ever change their own password — the property
 * `PaymentPinController` and `SettingsController` rely on, and the reason no action
 * carries a user id. There is no code path in this file, the DTOs, or the service
 * that reads an account identifier out of a request.
 */
@Injectable()
export class PasswordController {
  constructor(private readonly passwords: PasswordSettingsService) {}

  async status(principal: Principal): Promise<SuccessEnvelope<PasswordStatusPayload>> {
    const status = await this.passwords.status(principal.userId);
    return ok({ outcome: 'password_status', ...status });
  }

  /**
   * The three operations, on one `action` field.
   *
   * ─── The switch is the whole of the dispatch, and it is exhaustive ─────────
   *
   * `never` in the default arm means adding a member to `passwordRequestSchema`
   * without handling it fails the build. That matters more here than in most
   * controllers: an unhandled action would fall through to a returned `undefined`
   * rather than a refusal, which is a 200 for a write that never happened.
   *
   * ─── `factorVerified` is echoed from the SERVER, not the request ───────────
   *
   * `set` and `reset` are structurally incapable of verifying a factor, so both
   * report `null` as a fact rather than as an omission. Only `forgot` can report one,
   * and it reports what the service actually proved.
   *
   * ─── `otherSessionsRevoked: true` on all three ────────────────────────────
   *
   * Stated rather than left for the client to infer, per `BiometricsDisabledPayload`.
   * It is true because `PasswordSettingsService.finish` sweeps on every path — see
   * the note there for why `set` is not exempt.
   */
  async mutate(
    body: unknown,
    principal: Principal,
    facts: RequestFacts,
  ): Promise<SuccessEnvelope<PasswordChangedPayload>> {
    const input = parseDto(passwordRequestSchema, body);

    switch (input.action) {
      case 'set': {
        await this.passwords.set(principal, facts, input);
        // No password and no hash in the response, here or anywhere: the value the
        // caller sent is the only copy that ever existed outside argon2.
        return ok({
          outcome: 'password_changed',
          operation: 'set',
          factorVerified: null,
          otherSessionsRevoked: true,
        });
      }

      case 'reset': {
        await this.passwords.reset(principal, facts, input);
        return ok({
          outcome: 'password_changed',
          operation: 'reset',
          factorVerified: null,
          otherSessionsRevoked: true,
        });
      }

      case 'forgot': {
        const { factorVerified } = await this.passwords.forgot(principal, facts, input);
        return ok({
          outcome: 'password_changed',
          operation: 'forgot',
          factorVerified,
          otherSessionsRevoked: true,
        });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }
}
