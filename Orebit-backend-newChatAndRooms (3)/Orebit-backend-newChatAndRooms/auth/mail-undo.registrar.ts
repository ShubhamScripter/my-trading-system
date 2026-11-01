import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { MailUndoRegistry } from '../src/mail/mail.undo';
import { RegistrationDbOperation } from './persistence/registration.dboperation';

/**
 * Teaches the mail worker how to undo a registration's charged OTP send.
 *
 * ─── Why this class exists at all ───────────────────────────────────────────
 *
 * A `MailUndo` is data, so it can survive a crash in Redis — that is the whole point.
 * But something has to turn `{ kind: 'registration.refund-otp-send', registrationId }`
 * back into an UPDATE, and the only module that may touch the registrations table is
 * this one.
 *
 * `MailModule` is `@Global()` and imported everywhere, so it cannot depend on `auth`:
 * that is a cycle Nest would need `forwardRef` to resolve, and it would also mean a
 * mail queue that knows what a registration is — which is the first step towards one
 * that knows about everything.
 *
 * So the dependency is inverted. The registry holds a map of kind to handler, the
 * mail module fills in the two `cache.*` kinds it can service itself, and this
 * registers the one `auth` owns. The worker asks the registry and learns nothing.
 *
 * ─── Why a dedicated provider rather than a line in an existing service ─────
 *
 * Because registration happens at boot and has to happen exactly once, and hanging it
 * off `RegistrationService.onModuleInit` would tie a lifecycle hook to a class whose
 * job is a state machine. A four-line provider whose only purpose is visible from its
 * name is easier to find than a side effect inside something else.
 *
 * ─── Why the registration counts its own sends ──────────────────────────────
 *
 * Worth knowing, because it is why this undo is a database write rather than a cache
 * refund like the other two: a signup's OTP budget lives on the registration row, not
 * in Redis, so an attempt is not lost to a cache flush. A user midway through signing
 * up cannot re-request a code they have no session to prove they own.
 */
@Injectable()
export class MailUndoRegistrar implements OnModuleInit {
  private readonly logger = new Logger('MailUndoRegistrar');

  constructor(
    private readonly registry: MailUndoRegistry,
    private readonly registrations: RegistrationDbOperation,
  ) {}

  onModuleInit(): void {
    this.registry.register('registration.refund-otp-send', async (undo) => {
      // The union is exhaustive at the call site, but a handler registered for one
      // kind must still narrow before reading a field only that kind has.
      if (undo.kind !== 'registration.refund-otp-send') return;
      await this.registrations.refundOtpSend(undo.registrationId);
    });

    this.logger.log('registered the registration OTP-send compensation');
  }
}
