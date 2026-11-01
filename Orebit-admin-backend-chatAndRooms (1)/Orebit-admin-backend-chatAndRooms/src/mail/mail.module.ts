import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { OtpQueueDbOperation } from './otp-queue.dboperation';
import { OtpQueueService } from './otp-queue.service';

/**
 * Outbound email, and the durable queue that delivers the part of it that matters.
 *
 * `OtpQueueDbOperation` is provided here rather than imported from `auth/` on purpose:
 * `AuthModule` already imports this one, so reaching back would close a cycle. See
 * that file's header for why two statements were duplicated instead.
 */
@Global()
@Module({
  providers: [MailService, OtpQueueService, OtpQueueDbOperation],
  // `OtpQueueService` is exported for `LoginService`, which is its only producer.
  // `OtpQueueDbOperation` is not — it exists for the worker's compensation path and
  // nothing outside this module should be reaching for it.
  exports: [MailService, OtpQueueService],
})
export class MailModule {}
