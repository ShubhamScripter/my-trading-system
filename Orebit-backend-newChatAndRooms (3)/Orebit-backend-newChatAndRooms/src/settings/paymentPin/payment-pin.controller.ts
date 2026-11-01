import { Injectable } from '@nestjs/common';
import type { Principal } from '../../../auth/auth.types';
import type { RequestFacts } from '../../restrictions/restrictions.types';
import { ok, parseDto, type SuccessEnvelope } from '../../http';
import {
  paymentPinRequestSchema,
  paymentPinVerifySchema,
  type PaymentPinDisabledPayload,
  type PaymentPinEnabledPayload,
  type PaymentPinStatusPayload,
  type PaymentPinUpdatedPayload,
  type PaymentPinVerifiedPayload,
} from './payment-pin.dto';
import { PaymentPinService } from './payment-pin.service';

/**
 * Parse, delegate, serialise. No policy lives here.
 *
 * Every handler takes the acting account from the `Principal` and never from the body,
 * so a caller can only ever change their own Payment PIN — the same property
 * `SettingsController` and `TwoFactorController` rely on, and the reason no action
 * carries a user id. There is no code path in this file, the DTOs, or the service that
 * reads an account identifier out of a request.
 */
@Injectable()
export class PaymentPinController {
  constructor(private readonly paymentPin: PaymentPinService) {}

  async status(principal: Principal): Promise<SuccessEnvelope<PaymentPinStatusPayload>> {
    const status = await this.paymentPin.status(principal.userId);
    return ok({ outcome: 'payment_pin_status', ...status });
  }

  /**
   * One verification, over three methods on one `method` field.
   *
   * The union is discriminated and every member is `.strict()`, so a request naming one
   * method and carrying another's proof is refused by `parseDto` before this line runs.
   * See `paymentPinVerifySchema`.
   */
  async verify(
    body: unknown,
    principal: Principal,
  ): Promise<SuccessEnvelope<PaymentPinVerifiedPayload>> {
    const input = parseDto(paymentPinVerifySchema, body);

    const { challengeId, expiresInSeconds, method } = await this.paymentPin.verify(
      principal,
      input,
    );

    return ok({
      outcome: 'payment_pin_verified',
      challengeId,
      // Echoed from the request, which is also what the server bound into the
      // challenge — the two cannot differ, because the challenge was built from this
      // same parsed value.
      operation: input.operation,
      // Echoed from the SERVICE's return rather than from `input.method`, so what a
      // client renders is what was actually proved.
      method,
      expiresInSeconds,
    });
  }

  /**
   * The three operations, on one `action` field.
   *
   * One route rather than three because the client is doing one thing to one setting,
   * and because two of the three are authorised by the same challenge mechanism —
   * splitting them across routes would invite a reader to ask what guards each one
   * separately when the answer is identical.
   *
   * `ipClass` rather than the full `ClientContext`: the only thing needed downstream is
   * what the notification email reports, and asking the route for a full context would
   * additionally issue a device cookie as a side effect of reading it — the same reason
   * `SettingsRoutes.disableBiometrics` passes `req.ip` alone.
   */
  async mutate(
    body: unknown,
    principal: Principal,
    facts: RequestFacts,
  ): Promise<
    SuccessEnvelope<PaymentPinEnabledPayload | PaymentPinUpdatedPayload | PaymentPinDisabledPayload>
  > {
    const input = parseDto(paymentPinRequestSchema, body);

    switch (input.action) {
      case 'enable': {
        await this.paymentPin.enable(principal.userId, facts, input);
        // No PIN and no hash in the response, here or anywhere: the value the caller
        // sent is the only copy that ever existed outside argon2.
        return ok({ outcome: 'payment_pin_enabled', otherSessionsRevoked: false });
      }

      case 'update': {
        const { method } = await this.paymentPin.update(principal, facts, input);
        return ok({ outcome: 'payment_pin_updated', method, otherSessionsRevoked: false });
      }

      case 'disable': {
        const { method } = await this.paymentPin.disable(principal, facts, input);
        return ok({ outcome: 'payment_pin_disabled', method, otherSessionsRevoked: false });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }
}
