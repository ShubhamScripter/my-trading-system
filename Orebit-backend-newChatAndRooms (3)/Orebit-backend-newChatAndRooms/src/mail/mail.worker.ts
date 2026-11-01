import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { MAIL_QUEUE } from './mail.constants';
import { MailQueue, type ClaimedMail } from './mail.queue';
import { MailSender } from './mail.sender';
import { MailUndoRegistry } from './mail.undo';
import type { MailJob } from './mail.types';

/**
 * ═══ THE WORKER ═════════════════════════════════════════════════════════════
 *
 * One loop: reclaim what a dead worker abandoned, promote retries whose backoff has
 * elapsed, claim new work, deliver it. Repeat.
 *
 * ─── Why it runs in-process ─────────────────────────────────────────────────
 *
 * Because the durability that mattered is already won by the queue, and a separate
 * process buys isolation this service cannot currently deploy. A message is safe the
 * moment `XADD` returns — it survives this process being killed regardless of where
 * the worker lives, which is the property the in-memory version lacked.
 *
 * Nothing here assumes it is alone. The consumer group means several instances share
 * the stream without coordination, and `reclaimStalled` means one dying does not
 * strand its backlog. So moving the worker out later is a deployment change, not a
 * redesign: run this class in a process that serves no HTTP and the rest is unchanged.
 *
 * ─── Ordering inside the loop is deliberate ─────────────────────────────────
 *
 * Reclaim first, then promote, then claim new. A message that has already been
 * attempted has an older promise attached to it than one just enqueued, and a backlog
 * left by a crash should drain before new work rather than after it.
 *
 * ─── Why `OnApplicationBootstrap` and not `OnModuleInit` ────────────────────
 *
 * The loop must not start until every module has initialised — specifically until
 * `auth` has registered its undo handler. Starting at module-init would open a window
 * in which a dead-lettered message found no handler for its compensation and logged a
 * lost refund that was not actually lost.
 */
@Injectable()
export class MailWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('MailWorker');

  /**
   * This consumer's name within the group.
   *
   * Host plus a random suffix: the host makes a log line traceable to a machine, and
   * the suffix keeps two instances on one host — or a restarted one — from sharing a
   * name. Sharing would be actively harmful: a restarted worker inheriting its own
   * previous name would see its predecessor's pending messages as its own and never
   * reclaim them through the idle-time path.
   */
  private readonly consumer = `${hostname()}-${randomUUID().slice(0, 8)}`;

  private running = false;
  private cycle: Promise<void> = Promise.resolve();

  constructor(
    private readonly queue: MailQueue,
    private readonly sender: MailSender,
    private readonly undo: MailUndoRegistry,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    // Deliberately not awaited: this is a long-running loop, and awaiting it would
    // hang bootstrap forever. Its rejection is handled inside `run`.
    void this.run();

    void this.queue
      .depth()
      .then((depth) => this.logger.log({ consumer: this.consumer, ...depth }, 'mail worker started'))
      .catch(() => this.logger.log({ consumer: this.consumer }, 'mail worker started'));
  }

  /**
   * Stop claiming, and give the current batch a bounded chance to finish.
   *
   * Abandoning mid-batch is SAFE, which is the whole point of the queue: an unacked
   * message stays in the pending list and is reclaimed by another worker — or by this
   * one after a restart. The drain is a courtesy that avoids a duplicate send, not a
   * guard against loss.
   */
  async onApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    const drained = await Promise.race([
      this.cycle.then(() => true),
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), MAIL_QUEUE.DRAIN_TIMEOUT_MS),
      ),
    ]);

    this.logger.log(
      { drained },
      drained
        ? 'mail worker stopped cleanly'
        : 'mail worker abandoned its batch; unacked mail will be reclaimed',
    );
  }

  private async run(): Promise<void> {
    while (this.running) {
      this.cycle = this.tick();
      try {
        await this.cycle;
      } catch (err) {
        // The loop must outlive any single failure. A Redis blip that escapes the
        // inner handling must not silently end mail delivery for the process's
        // lifetime — which is what an unhandled rejection here would do.
        this.logger.error({ err }, 'mail worker cycle failed; continuing');
        await sleep(MAIL_QUEUE.BLOCK_MS);
      }
    }
  }

  private async tick(): Promise<void> {
    // 1. Refunds owed for mail that will never arrive. First, because a user waiting
    //    on a budget they were wrongly charged is blocked from retrying at all, and
    //    the work is a handful of Redis commands.
    await this.settleUndo();

    // 2. Retries whose backoff has elapsed, back onto the stream.
    //
    //    Unconditionally, and BEFORE the early return below. This used to sit after
    //    the stalled-work check, so a persistent backlog of reclaimable messages —
    //    exactly the situation a retry ladder exists for — meant `promoteDue` never
    //    ran at all and every parked retry sat in the sorted set indefinitely.
    await this.queue.promoteDue(MAIL_QUEUE.BATCH_SIZE);

    // 3. Anything a dead worker left behind. Oldest promises first.
    const stalled = await this.queue.reclaimStalled(this.consumer, MAIL_QUEUE.BATCH_SIZE);
    if (stalled.length > 0) {
      await this.deliverAll(stalled);
      return;
    }

    // 4. New work. Blocks, so an idle service is not spinning.
    const claimed = await this.queue.claim(
      this.consumer,
      MAIL_QUEUE.BATCH_SIZE,
      MAIL_QUEUE.BLOCK_MS,
    );
    await this.deliverAll(claimed);
  }

  /**
   * Run the compensations owed by dead-lettered mail, and settle the records that
   * complete.
   *
   * ─── Why a record is acked only when everything in it settled ───────────────
   *
   * Because the ack IS the retry mechanism. An unacked record stays in the group's
   * pending list and `XAUTOCLAIM` returns it after `RECLAIM_AFTER_MS`, so leaving it
   * is how a failed refund gets another attempt — no scheduler, no second structure,
   * and the same recovery path that already covers a worker dying mid-send.
   *
   * The compensations that DID succeed are not repeated on that redelivery: the
   * non-idempotent ones hold a once-only claim, and the rest are safe to repeat by
   * construction. See `MailUndoRegistry.runAll`.
   */
  private async settleUndo(): Promise<void> {
    const records = await this.queue.claimUndo(this.consumer, MAIL_QUEUE.BATCH_SIZE);

    for (const record of records) {
      if (!this.running) return; // Leave the rest pending; they will be reclaimed.

      const settled = await this.undo.runAll(record.undo, {
        jobId: record.jobId,
        kind: record.kind,
      });

      if (settled) {
        await this.queue.ackUndo(record.entryId);
        continue;
      }

      this.logger.error(
        { jobId: record.jobId, kind: record.kind },
        'compensation incomplete; leaving it pending for another attempt',
      );
    }
  }

  /**
   * Sequential, not `Promise.all`.
   *
   * The transport pool holds five connections, and firing a batch concurrently would
   * simply queue them inside nodemailer — where the queue is in-memory and NOT
   * durable, which is the property this whole change exists to establish. Handing
   * over one at a time keeps every unsent message in Redis.
   */
  private async deliverAll(batch: readonly ClaimedMail[]): Promise<void> {
    for (const item of batch) {
      if (!this.running) return; // Leave the rest pending; they will be reclaimed.
      await this.deliver(item);
    }
  }

  private async deliver({ entryId, job }: ClaimedMail): Promise<void> {
    const attempts = job.attempts + 1;

    let outcome: Awaited<ReturnType<MailSender['send']>>;
    try {
      outcome = await this.sender.send(job, attempts);
    } catch (err) {
      // `send` is written not to throw, so this is a bug rather than an SMTP failure.
      // Treated as a retryable failure: the alternative is acking a message nobody
      // tried to deliver.
      this.logger.error({ err, jobId: job.id }, 'mail sender threw');
      outcome = { status: 'unreachable', detail: describe(err) };
    }

    if (outcome.status === 'sent' || outcome.status === 'skipped') {
      await this.queue.ack(entryId);
      return;
    }

    // Three ways a message stops being retried, and they are terminal for three
    // different reasons.
    //
    //   `rejected`  a 550 for a mailbox that does not exist will be a 550 on every
    //               retry and on every relay, so retrying only doubles the reputation
    //               damage.
    //   `expired`   the content is dead. Every future attempt would deliver a code the
    //               recipient cannot use, which is worse than delivering nothing —
    //               it is the loop that made one OTP look like it was being resent
    //               forever.
    //   out of tries
    //
    // All three run the compensation below, and `expired` is the one that most needs
    // it: the user was charged a send for a message that never left the building.
    const terminal =
      outcome.status === 'rejected' ||
      outcome.status === 'expired' ||
      attempts >= MAIL_QUEUE.maxAttemptsFor(job.kind);

    const failed: MailJob = { ...job, attempts, lastError: outcome.detail };

    if (!terminal) {
      // Per-kind, so a one-time code retries fast and finishes inside its own
      // lifetime while ordinary mail keeps the patient ladder.
      await this.queue.scheduleRetry(entryId, failed, MAIL_QUEUE.backoffAfter(job.kind, attempts));
      return;
    }

    // Out of attempts, or terminally refused. Retire it and RECORD the compensation
    // it owes, in one atomic step — the compensation is the reason the job carries
    // `undo` as data rather than a closure.
    //
    // The refunds are not run here. They used to be, on the line after this one, and
    // that ordering was the bug: `deadLetter` acks and deletes the source entry, so a
    // crash in the gap left the user charged for mail that no longer existed anywhere,
    // with nothing recording that a refund was owed. `deadLetter` now writes the debt
    // to `mail:undo` inside the same script that retires the message, and
    // `settleUndo` drains it — which also means a refund that FAILS is retried instead
    // of being logged once and forgotten.
    await this.queue.deadLetter(entryId, failed, outcome.detail);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
