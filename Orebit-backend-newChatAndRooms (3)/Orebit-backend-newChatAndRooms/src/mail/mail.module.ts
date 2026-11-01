import { Global, Module } from '@nestjs/common';
import { MailDbOperation } from './mail.dboperation';
import { MailQueue } from './mail.queue';
import { MailSender } from './mail.sender';
import { MailService } from './mail.service';
import { MailUndoRegistry } from './mail.undo';
import { MailWorker } from './mail.worker';

/**
 * Outbound email: a producer on the request path, a durable queue, and a worker.
 *
 * ─── What is exported and what is not ───────────────────────────────────────
 *
 * `MailService` because everything sends mail. `MailUndoRegistry` because other
 * modules have to register handlers for the compensations they own —
 * `registration.refund-otp-send` is an UPDATE on a table this module must not know
 * about. See the note on the registry for why the dependency is inverted.
 *
 * `MailQueue`, `MailSender` and `MailWorker` are deliberately internal. Nothing
 * outside should enqueue a job by hand or drive the transport directly: the whole
 * value of the queue is that there is one way in, and it renders the message and
 * attaches the compensation.
 *
 * `MailWorker` is listed as a provider so Nest constructs it — it has no consumers,
 * and its lifecycle hooks are what start and stop the loop.
 */
@Global()
@Module({
  providers: [
    MailDbOperation,
    MailQueue,
    MailSender,
    MailUndoRegistry,
    MailService,
    MailWorker,
  ],
  exports: [MailService, MailUndoRegistry],
})
export class MailModule {}
