import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DurableRedisBlockingService, DurableRedisService, KEYS } from '../../redis';
import { MAIL_QUEUE } from './mail.constants';
import type { MailJob, MailUndo } from './mail.types';

/** A claimed message: the job plus the stream id needed to acknowledge it. */
export interface ClaimedMail {
  /** The Redis stream entry id. Only meaningful until it is acked. */
  readonly entryId: string;
  readonly job: MailJob;
}

/** A compensation record claimed from `mail:undo`. */
export interface ClaimedUndo {
  readonly entryId: string;
  readonly jobId: string;
  readonly kind: string;
  readonly undo: readonly MailUndo[];
}

/**
 * Move every due retry back onto the stream, atomically.
 *
 * ─── The window this closes ─────────────────────────────────────────────────
 *
 * This was `ZRANGEBYSCORE`, then a `ZREM` per message, then an `XADD` per message —
 * three round trips deep, with the `ZREM` and the `XADD` as separate commands. A
 * process that died between those two lost the message OUTRIGHT: `scheduleRetry` had
 * already acked and deleted the source entry, so once the `ZREM` succeeded the message
 * existed in the retry set no longer, in the stream not yet, in the pending list not at
 * all, and in the DLQ never. No reclaim could find it, and no compensation ever ran.
 *
 * That is the one silent-loss path in the whole subsystem, and it is exactly the
 * ordering discipline `scheduleRetry` argues for two methods above — applied in
 * reverse. A script cannot be interrupted between its commands, so there is no longer
 * an "in between" to die in.
 *
 * The `ZREM` return is still checked. Every API instance runs a worker, so several are
 * promoting concurrently; the conditional is what stops two of them enqueuing the same
 * message. Inside the script it is now a formality on one node, but it keeps the
 * intent explicit and stays correct if this ever runs against a proxy.
 *
 * `XADD *` is non-deterministic, which mattered under the pre-5.0 replication model
 * where scripts were shipped to replicas verbatim. Redis 7 — the deployed image —
 * replicates the script's EFFECTS, so the id generated here is the id replicated, and
 * a `redis.replicate_commands()` call is unnecessary.
 */
const PROMOTE_DUE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local promoted = 0
for i = 1, #due do
  if redis.call('ZREM', KEYS[1], due[i]) == 1 then
    redis.call('XADD', KEYS[2], '*', 'job', due[i])
    promoted = promoted + 1
  end
end
return promoted
`;

/**
 * Retire a message and record the compensation it owes, atomically.
 *
 * ─── The window this closes ─────────────────────────────────────────────────
 *
 * Dead-lettering used to be `XADD` to the DLQ, then `XACK` + `XDEL` of the source,
 * with `MailUndoRegistry.runAll` called afterwards from the worker. By the time the
 * undo list was reached the message had already been fully retired, so a crash in that
 * gap left the user charged for mail that would never arrive — with no record anywhere
 * that a refund was outstanding. The undo list was inside the DLQ entry, but nothing
 * reads the DLQ.
 *
 * Writing the debt to `mail:undo` in the same script that retires the message makes it
 * durable BEFORE the message stops existing. The worker then drains that stream, and
 * acks a record only once every compensation in it has been settled — so the failure
 * mode is a retry rather than a loss.
 *
 * KEYS: 1 dlq, 2 undo stream, 3 work stream.  ARGV: 1 job json, 2 reason,
 * 3 dlq maxlen, 4 source entry id, 5 group, 6 job id, 7 kind, 8 undo json.
 */
const DEAD_LETTER = `
redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[3], '*', 'job', ARGV[1], 'reason', ARGV[2])
if ARGV[8] ~= '[]' then
  redis.call('XADD', KEYS[2], '*', 'jobId', ARGV[6], 'kind', ARGV[7], 'undo', ARGV[8])
end
redis.call('XACK', KEYS[3], ARGV[5], ARGV[4])
redis.call('XDEL', KEYS[3], ARGV[4])
return 1
`;

/** The scripts, once `defineCommand` has attached them to a connection. */
interface MailCommands {
  mailPromoteDue(...args: (string | number)[]): Promise<number>;
  mailDeadLetter(...args: (string | number)[]): Promise<number>;
}

type MailRedis = DurableRedisService & MailCommands;

/**
 * ═══ THE DURABLE MAIL QUEUE ═════════════════════════════════════════════════
 *
 * Three Redis structures, each doing one job that the others cannot:
 *
 *   `mail:stream`  the work, as a Stream with a consumer group. `XADD` enqueues,
 *                  `XREADGROUP` claims, `XACK` finishes.
 *   `mail:retry`   messages waiting out a backoff, as a sorted set scored by due
 *                  time. Streams have no delay, so a failure parks here.
 *   `mail:dlq`     messages that exhausted their attempts, as a Stream.
 *
 * ─── Why a Stream and not a List ────────────────────────────────────────────
 *
 * Crash recovery. The reliable-list pattern (`BRPOPLPUSH` onto a processing list)
 * needs a second structure plus a reaper that can tell a dead worker from a slow one,
 * and getting that reaper wrong either loses messages or sends them twice.
 *
 * A consumer group keeps that bookkeeping itself. A message read by `XREADGROUP` and
 * not yet acked sits in the group's pending-entries list, tagged with the consumer
 * that holds it and how long it has been idle. `XAUTOCLAIM` transfers anything idle
 * past a threshold to whoever asks. So a process killed mid-send loses nothing: the
 * message is still pending, and the next worker to call `reclaimStalled` picks it up.
 *
 * ─── At-least-once, and what that obliges callers to accept ─────────────────
 *
 * This is at-least-once, not exactly-once, and it cannot be otherwise: a worker can
 * hand a message to SMTP and die before acking, and nothing in Redis can distinguish
 * that from dying before sending. The consequence is that a duplicate email is
 * possible — rare, requiring a crash inside a narrow window, and the correct trade.
 * The alternative failure is a one-time code that never arrives at all, and a user
 * who receives two copies of the same code is inconvenienced rather than locked out.
 *
 * Everything downstream is already idempotent under this: the code in the message was
 * generated once and stored hashed once, so two copies are two copies of one code
 * rather than two codes.
 */
@Injectable()
export class MailQueue implements OnModuleInit {
  private readonly logger = new Logger('MailQueue');
  private readonly stream = KEYS.mail.stream();
  private readonly group = KEYS.mail.group();
  private readonly retryKey = KEYS.mail.retry();
  private readonly dlqKey = KEYS.mail.dlq();
  private readonly undoKey = KEYS.mail.undo();
  private readonly undoGroup = KEYS.mail.undoGroup();
  /** The same connection as `redis`, with the two scripts attached. */
  private readonly scripts: MailRedis;

  /**
   * Two connections to ONE durable instance.
   *
   * `redis` runs every ordinary command; `blocking` does nothing but sit in
   * `XREADGROUP ... BLOCK`. They are separate because ioredis pipelines commands onto
   * a connection in order, so while the worker was parked for its five-second poll,
   * an OTP enqueue arriving on the request path waited behind it — a queue's idle loop
   * adding latency to the very sends it exists to deliver. See the note on
   * `DurableRedisBlockingService`.
   */
  constructor(
    private readonly redis: DurableRedisService,
    private readonly blocking: DurableRedisBlockingService,
  ) {
    // `defineCommand` rather than `eval`, so ioredis sends `EVALSHA` and falls back to
    // the full script only on `NOSCRIPT` — once per Redis restart rather than once per
    // call. Same pattern as `QuotaService.attach`.
    redis.defineCommand('mailPromoteDue', { lua: PROMOTE_DUE, numberOfKeys: 2 });
    redis.defineCommand('mailDeadLetter', { lua: DEAD_LETTER, numberOfKeys: 3 });
    this.scripts = redis as MailRedis;
  }

  /**
   * Create the consumer group, once, if it does not exist.
   *
   * `MKSTREAM` so the group can be created before the first message — without it,
   * `XGROUP CREATE` on a stream that does not exist is an error, and the first
   * enqueue after a fresh deploy would race the first read.
   *
   * `BUSYGROUP` is swallowed because every app instance runs this at boot and only
   * one can win. That is not a failure; it is the expected outcome for all but one.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM');
      this.logger.log({ stream: this.stream, group: this.group }, 'consumer group created');
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) {
        // Anything else is a real problem — a wrong key type, a permissions issue — and
        // must not be hidden, because the queue will not work and mail will pile up.
        this.logger.error({ err }, 'could not create the mail consumer group');
        throw err;
      }
    }

    // Unconditionally, not in the `try` above: BUSYGROUP on the WORK stream used to
    // `return` early, which would leave the compensation group uncreated on every
    // instance but the first to boot.
    await this.ensureUndoGroup();
  }

  /** Put a message on the stream. The only way a job enters the system. */
  async enqueue(job: MailJob): Promise<void> {
    await this.redis.xadd(this.stream, '*', 'job', JSON.stringify(job));
  }

  /**
   * Claim up to `count` messages, waiting up to `blockMs` for one to appear.
   *
   * `'>'` means "messages never delivered to this group", which is what makes the
   * consumer group a queue rather than a log: two instances calling this get disjoint
   * sets. Already-delivered-but-unacked messages are NOT returned here — those are
   * `reclaimStalled`'s job, and keeping the two separate is what stops a crashed
   * worker's backlog starving new mail.
   *
   * The block is what keeps this off a polling loop. `maxRetriesPerRequest: null` on
   * the durable connection is what allows it — see `DurableRedisBlockingService`.
   *
   * The ONLY caller of `this.blocking`, and the reason that connection exists: parking
   * a shared socket here made every other durable command wait out the block.
   */
  async claim(consumer: string, count: number, blockMs: number): Promise<ClaimedMail[]> {
    const response = (await this.blocking.xreadgroup(
      'GROUP',
      this.group,
      consumer,
      'COUNT',
      count,
      'BLOCK',
      blockMs,
      'STREAMS',
      this.stream,
      '>',
    )) as [string, [string, string[]][]][] | null;

    return this.parseEntries(response);
  }

  /**
   * Take over messages a dead worker never acked.
   *
   * This is the crash-recovery path, and it is why the queue is a Stream. A message
   * claimed by a consumer that then died stays in the pending-entries list forever
   * unless something reclaims it — it is not lost, but nor does it move.
   *
   * `XAUTOCLAIM` with a minimum idle time is the whole mechanism: anything held longer
   * than a worker could plausibly still be working on it is transferred to us. The
   * idle threshold has to exceed the SMTP timeouts, or a slow-but-alive worker gets
   * its message stolen and the message is sent twice.
   */
  async reclaimStalled(consumer: string, count: number): Promise<ClaimedMail[]> {
    const response = (await this.redis.xautoclaim(
      this.stream,
      this.group,
      consumer,
      MAIL_QUEUE.RECLAIM_AFTER_MS,
      '0-0',
      'COUNT',
      count,
    )) as [string, [string, string[]][], string[]] | null;

    if (response === null) return [];
    const claimed = this.parseEntries([[this.stream, response[1]]]);
    if (claimed.length > 0) {
      this.logger.warn(
        { count: claimed.length, consumer },
        'reclaimed mail a previous worker never acknowledged',
      );
    }
    return claimed;
  }

  /**
   * Finish with a message: acknowledge it, then delete it.
   *
   * ─── Why XDEL as well as XACK, which is easy to miss ───────────────────────
   *
   * `XACK` removes an entry from the consumer group's PENDING list. It does NOT
   * remove it from the stream — a Stream is a log, and an acked entry sits in it
   * forever. So an `XACK`-only queue grows without bound: `XLEN` climbs by one for
   * every email the service has ever sent, and the memory is never reclaimed.
   *
   * That was measurable rather than theoretical here: one register request left
   * `XLEN mail:stream` at 1 with `pending` at 0 — delivered, acknowledged, and still
   * occupying the stream.
   *
   * `XDEL` is safe precisely because it follows the ack. The entry has been delivered
   * and acknowledged by this consumer, so nothing else holds a claim on it: the DLQ
   * keeps failures and `mail_deliveries` keeps the per-attempt audit, which is where
   * history belongs. The alternative — `MAXLEN` on `XADD` — trims by count regardless
   * of whether the trimmed entries have been processed, and would silently discard
   * queued mail during exactly the backlog it is meant to survive.
   */
  async ack(entryId: string): Promise<void> {
    await this.redis.xack(this.stream, this.group, entryId);
    await this.redis.xdel(this.stream, entryId);
  }

  /**
   * Park a failed message until its backoff elapses, then ack the original entry.
   *
   * Ack-then-reschedule rather than leaving it pending, and the order matters: the
   * new entry is written to the retry set BEFORE the old one is acknowledged, so a
   * crash between the two leaves the message pending (it will be reclaimed) rather
   * than acked-and-forgotten. Duplicating a message is recoverable; losing it is not.
   */
  async scheduleRetry(entryId: string, job: MailJob, delayMs: number): Promise<void> {
    const due = Date.now() + delayMs;
    await this.redis.zadd(this.retryKey, due, JSON.stringify(job));
    await this.ack(entryId);

    this.logger.log(
      { jobId: job.id, kind: job.kind, attempts: job.attempts, dueInMs: delayMs },
      'mail delivery failed; retry scheduled',
    );
  }

  /**
   * Move every due retry back onto the stream, in one atomic step.
   *
   * See `PROMOTE_DUE` for what the script closes: as three separate round trips, a
   * crash between the `ZREM` and the `XADD` lost the message with no trace.
   */
  async promoteDue(limit: number): Promise<number> {
    const promoted = await this.scripts.mailPromoteDue(
      this.retryKey,
      this.stream,
      Date.now(),
      limit,
    );

    if (promoted > 0) this.logger.log({ promoted }, 'due mail retries returned to the queue');
    return promoted;
  }

  /**
   * Retire a message that will not be attempted again, and ack it.
   *
   * Kept rather than dropped. A message here is the answer to "the code never
   * arrived": it carries the recipient, the template, every attempt made and the error
   * that finally retired it. `MAXLEN ~` caps the stream so it cannot grow without
   * bound during a sustained outage — approximate trimming, because exact trimming
   * costs more than the precision is worth for an audit log.
   */
  async deadLetter(entryId: string, job: MailJob, reason: string): Promise<void> {
    // One script: DLQ entry, compensation record, ack, delete. The undo record is
    // written before the message stops existing, so the debt cannot be lost with it —
    // see `DEAD_LETTER`.
    await this.scripts.mailDeadLetter(
      this.dlqKey,
      this.undoKey,
      this.stream,
      JSON.stringify(job),
      reason,
      MAIL_QUEUE.DLQ_MAX_LEN,
      entryId,
      this.group,
      job.id,
      job.kind,
      JSON.stringify(job.undo),
    );

    this.logger.error(
      { jobId: job.id, kind: job.kind, to: job.body.to, attempts: job.attempts, reason },
      'mail dead-lettered after exhausting every attempt — recipient did NOT get this message',
    );
  }

  /**
   * Create the compensation consumer group, once, if it does not exist.
   *
   * `'0'` rather than `'$'`: a group starting at the tail would skip every record
   * already waiting, which for this stream means silently abandoning refunds written
   * before the first worker started.
   */
  private async ensureUndoGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.undoKey, this.undoGroup, '0', 'MKSTREAM');
    } catch (err) {
      if (err instanceof Error && err.message.includes('BUSYGROUP')) return;
      throw err;
    }
  }

  /**
   * Claim compensation records to settle — new ones, then anything a dead worker left
   * unacked.
   *
   * Non-blocking, unlike `claim`: this runs as one step of the worker's cycle, and the
   * cycle already blocks on the work stream. Blocking here too would double the idle
   * latency for no benefit.
   *
   * The reclaim half is what makes the retry work. A record is acked only when every
   * compensation in it has settled, so one that failed stays pending and comes back
   * here after `RECLAIM_AFTER_MS` — no separate scheduler, and the same recovery path
   * that already covers a worker dying mid-send.
   */
  async claimUndo(consumer: string, count: number): Promise<ClaimedUndo[]> {
    const fresh = (await this.redis.xreadgroup(
      'GROUP',
      this.undoGroup,
      consumer,
      'COUNT',
      count,
      'STREAMS',
      this.undoKey,
      '>',
    )) as [string, [string, string[]][]][] | null;

    const claimed = this.parseUndo(fresh === null ? [] : (fresh[0]?.[1] ?? []));
    if (claimed.length > 0) return claimed;

    const stalled = (await this.redis.xautoclaim(
      this.undoKey,
      this.undoGroup,
      consumer,
      MAIL_QUEUE.RECLAIM_AFTER_MS,
      '0-0',
      'COUNT',
      count,
    )) as [string, [string, string[]][], string[]] | null;

    return this.parseUndo(stalled === null ? [] : (stalled[1] ?? []));
  }

  /** Settle a compensation record. Called only once every undo in it has run. */
  async ackUndo(entryId: string): Promise<void> {
    await this.redis.xack(this.undoKey, this.undoGroup, entryId);
    await this.redis.xdel(this.undoKey, entryId);
  }

  private parseUndo(entries: readonly [string, string[]][]): ClaimedUndo[] {
    const records: ClaimedUndo[] = [];

    for (const [entryId, fields] of entries) {
      const read = (name: string): string | undefined => {
        const at = fields.indexOf(name);
        return at === -1 ? undefined : fields[at + 1];
      };

      const raw = read('undo');
      if (raw === undefined) {
        this.logger.error({ entryId }, 'undo record has no payload; dropping it');
        void this.ackUndo(entryId).catch((err: unknown) =>
          this.logger.error({ err, entryId }, 'could not drop a malformed undo record'),
        );
        continue;
      }

      try {
        records.push({
          entryId,
          jobId: read('jobId') ?? 'unknown',
          kind: read('kind') ?? 'unknown',
          undo: JSON.parse(raw) as MailUndo[],
        });
      } catch (err) {
        // Unparseable, so it can never be settled. Acking it stops it being reclaimed
        // forever; the log is the only remaining record that a refund was owed.
        this.logger.error({ err, entryId }, 'undo record is unparseable; dropping it');
        void this.ackUndo(entryId).catch((ackErr: unknown) =>
          this.logger.error({ err: ackErr, entryId }, 'could not drop an unparseable undo record'),
        );
      }
    }

    return records;
  }

  /** Queue depth, for the boot log and an eventual admin surface. */
  async depth(): Promise<{ pending: number; retrying: number; dead: number }> {
    const [pending, retrying, dead] = await Promise.all([
      this.redis.xlen(this.stream),
      this.redis.zcard(this.retryKey),
      this.redis.xlen(this.dlqKey),
    ]);
    return { pending, retrying, dead };
  }

  /**
   * Parse an `XREADGROUP`/`XAUTOCLAIM` response into jobs.
   *
   * An entry whose payload will not parse is ACKED AND DROPPED rather than retried.
   * That looks harsh, but a message that cannot be deserialised cannot be delivered
   * either, and leaving it pending would make it a permanent poison entry that every
   * reclaim picks up and every worker fails on. It is logged with its raw payload so
   * the shape change that caused it is diagnosable.
   */
  private parseEntries(
    response: [string, [string, string[]][]][] | null,
  ): ClaimedMail[] {
    if (response === null) return [];

    const claimed: ClaimedMail[] = [];
    for (const [, entries] of response) {
      for (const [entryId, fields] of entries) {
        // `XAUTOCLAIM` can return a null field list for an entry that was trimmed
        // out from under the pending list.
        if (fields === null || fields === undefined) {
          void this.ack(entryId).catch((err: unknown) =>
            this.logger.error({ err, entryId }, 'could not drop a poison entry'),
          );
          continue;
        }

        const raw = fieldValue(fields, 'job');
        if (raw === undefined) {
          this.logger.error({ entryId, fields }, 'mail entry has no job field; dropping');
          void this.ack(entryId).catch((err: unknown) =>
            this.logger.error({ err, entryId }, 'could not drop a poison entry'),
          );
          continue;
        }

        try {
          claimed.push({ entryId, job: JSON.parse(raw) as MailJob });
        } catch (err) {
          this.logger.error(
            { entryId, raw: raw.slice(0, 500), err },
            'mail entry could not be parsed; dropping rather than poisoning the queue',
          );
          void this.ack(entryId).catch((err: unknown) =>
            this.logger.error({ err, entryId }, 'could not drop a poison entry'),
          );
        }
      }
    }
    return claimed;
  }
}

/** Redis returns stream fields as a flat `[k, v, k, v]` array. */
function fieldValue(fields: string[], key: string): string | undefined {
  for (let i = 0; i < fields.length - 1; i += 2) {
    if (fields[i] === key) return fields[i + 1];
  }
  return undefined;
}
