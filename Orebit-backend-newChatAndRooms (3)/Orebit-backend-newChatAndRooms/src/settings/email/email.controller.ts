import { Injectable } from '@nestjs/common';
import type { Principal } from '../../../auth/auth.types';
import { ERR } from '../../contracts';
import { ProblemException, ok, parseDto, type SuccessEnvelope } from '../../http';
import {
  emailChangeRequestSchema,
  emailVerifySchema,
  isRecoveryVerify,
  type EmailChangeStartedPayload,
  type EmailChangedPayload,
  type EmailCodeResentPayload,
  type EmailRecoveredPayload,
  type EmailRecoveryStartedPayload,
  type EmailStatusPayload,
} from './email.dto';
import { EmailChangeService } from './email.service';
import type { RequestFacts } from '../../restrictions/restrictions.types';
import { maskEmail } from './email.utility';

/**
 * Parse, delegate, serialise. No policy lives here.
 *
 * ═══ THE ONE THING THIS FILE IS RESPONSIBLE FOR ═════════════════════════════
 *
 * Two of the three routes are `@Public()`, because the recovery branch has to be
 * reachable by somebody with no session — a completed change sweeps every session and
 * the released address cannot sign in, which is the whole situation recovery exists for.
 *
 * That makes `requireCaller` below the highest-risk function in the feature. Every
 * non-recovery branch calls it, and a branch that forgot to would be an unauthenticated
 * email change. So the branching is structural rather than conditional: the action union
 * is switched on exhaustively, the recovery members are the only ones that read
 * `optionalPrincipal`, and every other member's first statement is `requireCaller`.
 *
 * The recovery branches never see a principal at all, even when one is present. A
 * session must not be able to influence a ceremony authorised by a mailed ticket, and
 * the simplest way to guarantee that is for the code path not to have access to it.
 */
@Injectable()
export class EmailChangeController {
  constructor(private readonly email: EmailChangeService) {}

  async status(principal: Principal): Promise<SuccessEnvelope<EmailStatusPayload>> {
    const status = await this.email.status(principal);
    return ok({ outcome: 'email_status', ...status });
  }

  /**
   * `start`, `resend` and `recover-start` on one `action` field.
   *
   * `principal` is nullable because this route is public. Which branches tolerate that
   * is decided by the switch below and nowhere else.
   */
  async mutate(
    body: unknown,
    principal: Principal | null,
    ipAddress: string,
    ipClass: string,
  ): Promise<
    SuccessEnvelope<
      EmailChangeStartedPayload | EmailCodeResentPayload | EmailRecoveryStartedPayload
    >
  > {
    const input = parseDto(emailChangeRequestSchema, body);

    switch (input.action) {
      case 'start': {
        const started = await this.email.start(requireCaller(principal), ipAddress, input);
        return ok({
          outcome: 'email_change_started',
          challengeId: started.challengeId,
          // Echoed masked. The caller supplied it, so this reveals nothing they did not
          // send — but a settings screen should render the masked form, and returning
          // the full value would invite a client to display it.
          newEmail: maskEmail(started.newEmail),
          method: started.method,
          requiredTargets: started.requiredTargets,
          expiresInSeconds: started.expiresInSeconds,
        });
      }

      case 'resend': {
        await this.email.resend(requireCaller(principal), ipAddress, input);
        return ok({ outcome: 'email_code_resent', target: input.target });
      }

      case 'recover-start': {
        // Deliberately does NOT touch `principal`, even if one is present.
        const started = await this.email.recoverStart(ipAddress, ipClass, input);
        return ok({
          outcome: 'email_recovery_started',
          recoveryId: started.challengeId,
          intent: started.intent,
          targetEmail: maskEmail(started.targetEmail),
          expiresInSeconds: started.expiresInSeconds,
        });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  /**
   * Complete either ceremony.
   *
   * The two shapes are told apart by `isRecoveryVerify`, a type guard on the presence of
   * `recoveryId` — so the compiler, not a comment, is what keeps the authenticated
   * branch from receiving a recovery body.
   */
  async verify(
    body: unknown,
    principal: Principal | null,
    ipAddress: string,
    /** The full request facts: the CHANGE branch is a trigger action and needs the
     *  country and request id, while the RECOVERY branch needs only `ipClass`. */
    facts: RequestFacts,
  ): Promise<SuccessEnvelope<EmailChangedPayload | EmailRecoveredPayload>> {
    const input = parseDto(emailVerifySchema, body);

    if (isRecoveryVerify(input)) {
      const recovered = await this.email.verifyRecovery(ipAddress, facts.ipClass, input);
      return ok({
        outcome: 'email_recovered',
        email: maskEmail(recovered.email),
        intent: recovered.intent,
        otherSessionsRevoked: true,
      });
    }

    const changed = await this.email.verifyChange(requireCaller(principal), facts, input);
    return ok({
      outcome: 'email_changed',
      email: maskEmail(changed.email),
      // Always true, and true here where it is false for the Payment PIN: the released
      // address is a sign-in credential, so a session may have been established with it.
      otherSessionsRevoked: true,
    });
  }
}

/**
 * The session every non-recovery branch requires.
 *
 * A free function rather than an inline check, so there is exactly ONE place that turns
 * "no principal" into a refusal and exactly one thing to grep for when asking which
 * branches are authenticated. `requirePrincipal` in the guards module cannot serve: it
 * reads the request, and by this layer the request is gone — which is itself the point,
 * since a controller that could reach the request could reach a principal the route
 * decided not to pass.
 */
function requireCaller(principal: Principal | null): Principal {
  if (principal === null) {
    throw new ProblemException({
      type: ERR.UNAUTHENTICATED,
      detail: 'Sign in to change your email address.',
    });
  }
  return principal;
}
