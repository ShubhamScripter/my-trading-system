import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableRedisBlockingService, DurableRedisService } from '../../redis';
import { KEYS } from '../../redis';
import { MAIL_QUEUE } from '../../src/mail/mail.constants';
import { MailQueue } from '../../src/mail/mail.queue';
import type { MailJob } from '../../src/mail/mail.types';

/**
 * MailQueue against a hand-written Redis double.
 *
 * ─── What is being tested, and what deliberately is not ─────────────────────
 *
 * Not "does Redis implement Streams correctly" — it does, and asserting that would be
 * testing Redis. What matters here is the CONTRACT this class has with Redis, because
 * every one of the durability properties is a consequence of getting the arguments
 * right: `'>'` versus `'0'` on `XREADGROUP` is the difference between a queue and a
 * log; the order of `ZADD` and `XACK` in `scheduleRetry` is the difference between
 * duplicating a message and losing it; and a `ZREM` whose result is ignored lets two
 * workers promote the same retry.
 *
 * None of that is visible in an integration test that happens to pass — a mis-ordered
 * ack only loses a message when the process dies in the window between two commands.
 * So the commands themselves are the assertion.
 */

const job: MailJob = {
  id: 'job-1',
  kind: 'otp',
  body: { to: 'ada@example.test', subject: 'code', text: 'code', html: '<p>code</p>' },
  undo: [{ kind: 'cache.refund', key: 'rate:x' }],
  attempts: 0,
  queuedAt: new Date().toISOString(),
};

/** Records the order every command was issued in — several assertions are about
 *  ordering rather than about any single call. */
let order: string[];

function createRedis() {
  // `Promise<unknown>` rather than the default's own type: several cases override the
  // resolved value with a stream response, and inferring from the default would pin
  // each mock to whatever that default happened to be.
  const track = (name: string, result: unknown) =>
    vi.fn(async (...args: unknown[]): Promise<unknown> => {
      order.push(name);
      void args;
      return result;
    });

  return {
    xgroup: track('xgroup', 'OK'),
    xadd: track('xadd', '1-0'),
    xack: track('xack', 1),
    xdel: track('xdel', 1),
    xreadgroup: track('xreadgroup', null),
    xautoclaim: track('xautoclaim', null),
    zadd: track('zadd', 1),
    zrem: track('zrem', 1),
    zrangebyscore: track('zrangebyscore', [] as string[]),
    xlen: track('xlen', 0),
    zcard: track('zcard', 0),

    // `MailQueue` attaches its two Lua scripts in the constructor, exactly as
    // `QuotaService` does, so the double has to accept the registration and then
    // answer to the names it created.
    defineCommand: vi.fn(),
    mailPromoteDue: track('mailPromoteDue', 0),
    mailDeadLetter: track('mailDeadLetter', 1),
  };
}

let redis: ReturnType<typeof createRedis>;
/** The blocking connection. Separate from `redis` here for the same reason it is
 *  separate in production: only `claim` may touch it, and a doubled second connection
 *  is what lets a test assert that nothing else does. */
let blocking: ReturnType<typeof createRedis>;
let queue: MailQueue;

beforeEach(() => {
  order = [];
  redis = createRedis();
  blocking = createRedis();
  queue = new MailQueue(
    redis as unknown as DurableRedisService,
    blocking as unknown as DurableRedisBlockingService,
  );
});

/** One stream entry, in the shape ioredis returns. */
function entry(id: string, payload: unknown): [string, string[]] {
  return [id, ['job', JSON.stringify(payload)]];
}

describe('MailQueue.onModuleInit', () => {
  it('creates the consumer group with MKSTREAM', async () => {
    // Without MKSTREAM the group cannot be created before the first message, so the
    // first enqueue after a fresh deploy would race the first read.
    await queue.onModuleInit();

    expect(redis.xgroup).toHaveBeenCalledWith(
      'CREATE',
      KEYS.mail.stream(),
      KEYS.mail.group(),
      '0',
      'MKSTREAM',
    );
  });

  it('tolerates BUSYGROUP, because every instance races to create it', async () => {
    // Only one instance can win, and the others losing is the expected outcome rather
    // than a failure.
    redis.xgroup.mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists'));
    await expect(queue.onModuleInit()).resolves.toBeUndefined();
  });

  it('rethrows anything else, because the queue will not work', async () => {
    // A wrong key type or a permissions problem must not be swallowed: mail would
    // silently pile up with nothing draining it.
    redis.xgroup.mockRejectedValue(new Error('WRONGTYPE'));
    await expect(queue.onModuleInit()).rejects.toThrow(/WRONGTYPE/);
  });
});

describe('MailQueue.claim', () => {
  it("reads with '>' so two instances get disjoint work", async () => {
    // `'>'` means "never delivered to this group". Reading `'0'` instead would return
    // this consumer's already-pending messages and make the stream a log rather than
    // a queue — every instance would process every message.
    await queue.claim('worker-1', 5, 1_000);

    const args = blocking.xreadgroup.mock.calls[0] as unknown[];
    expect(args).toContain('>');
    expect(args).not.toContain('0');
    expect(args).toContain('GROUP');
    expect(args).toContain(KEYS.mail.group());
  });

  it('blocks, so an idle service is not polling', async () => {
    await queue.claim('worker-1', 5, 4_321);
    const args = blocking.xreadgroup.mock.calls[0] as unknown[];
    expect(args).toContain('BLOCK');
    expect(args).toContain(4_321);
  });

  it('returns nothing when the block elapses with no work', async () => {
    blocking.xreadgroup.mockResolvedValue(null);
    await expect(queue.claim('worker-1', 5, 10)).resolves.toEqual([]);
  });

  it('parses entries into jobs with their stream ids', async () => {
    blocking.xreadgroup.mockResolvedValue([[KEYS.mail.stream(), [entry('5-0', job)]]]);

    const claimed = await queue.claim('worker-1', 5, 10);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.entryId).toBe('5-0');
    expect(claimed[0]?.job.id).toBe('job-1');
  });

  it('drops an unparseable entry rather than poisoning the queue', async () => {
    // A payload that will not deserialise cannot be delivered either. Leaving it
    // pending would make it a permanent poison entry that every reclaim picks up and
    // every worker fails on.
    blocking.xreadgroup.mockResolvedValue([[KEYS.mail.stream(), [['9-0', ['job', '{not json']]]]]);

    const claimed = await queue.claim('worker-1', 5, 10);

    expect(claimed).toEqual([]);
    expect(redis.xack).toHaveBeenCalled();
  });

  it('drops an entry with no job field', async () => {
    blocking.xreadgroup.mockResolvedValue([[KEYS.mail.stream(), [['9-1', ['other', 'x']]]]]);

    await expect(queue.claim('worker-1', 5, 10)).resolves.toEqual([]);
    expect(redis.xack).toHaveBeenCalled();
  });
});

describe('MailQueue.reclaimStalled — the crash-recovery path', () => {
  it('claims only messages idle longer than the reclaim threshold', async () => {
    // The threshold must exceed the transport timeouts, or a slow-but-alive worker
    // has its message stolen and the message is sent twice.
    await queue.reclaimStalled('worker-2', 5);

    const args = redis.xautoclaim.mock.calls[0] as unknown[];
    expect(args).toContain(MAIL_QUEUE.RECLAIM_AFTER_MS);
    expect(args).toContain('0-0');
  });

  it('returns what a dead worker never acknowledged', async () => {
    redis.xautoclaim.mockResolvedValue(['0-0', [entry('7-0', job)], []]);

    const claimed = await queue.reclaimStalled('worker-2', 5);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.job.id).toBe('job-1');
  });

  it('returns nothing when there is nothing stalled', async () => {
    redis.xautoclaim.mockResolvedValue(['0-0', [], []]);
    await expect(queue.reclaimStalled('worker-2', 5)).resolves.toEqual([]);
  });
});

describe('MailQueue.scheduleRetry', () => {
  it('parks the job BEFORE acking the original entry', async () => {
    // The ordering is the durability property. Acking first and crashing before the
    // ZADD loses the message outright; this order leaves it pending, so it is
    // reclaimed. Duplicating a message is recoverable — losing it is not.
    await queue.scheduleRetry('3-0', job, 5_000);

    expect(order.indexOf('zadd')).toBeLessThan(order.indexOf('xack'));
  });

  it('scores the entry by when it becomes due', async () => {
    const before = Date.now();
    await queue.scheduleRetry('3-0', job, 30_000);

    const [key, score] = redis.zadd.mock.calls[0] as [string, number];
    expect(key).toBe(KEYS.mail.retry());
    expect(score).toBeGreaterThanOrEqual(before + 30_000);
  });
});

describe('MailQueue.promoteDue — atomic, because the gap used to lose mail', () => {
  /**
   * These assertions changed shape when the promotion moved into Lua, and the reason
   * is the point rather than an inconvenience.
   *
   * The old tests asserted an ORDER between two client-side commands: `ZREM` before
   * `XADD`, so that a crash in between duplicated rather than lost. That was the best
   * available guarantee at the time and it was still wrong — `scheduleRetry` has
   * already acked and deleted the source entry by then, so a crash after a winning
   * `ZREM` left the message in no structure at all. Not pending, not in the retry set,
   * not on the stream, never in the DLQ. Nothing could find it and no compensation
   * ever ran.
   *
   * An ordering between two round trips cannot fix that; only removing the gap can.
   * So the assertion is no longer "which command came first" but "there is exactly one
   * command", which is the property that makes the question moot.
   */
  it('promotes in ONE round trip, so there is no gap to crash in', async () => {
    await queue.promoteDue(10);

    expect(redis.mailPromoteDue).toHaveBeenCalledTimes(1);
    // The client no longer issues any of these itself — that is what "atomic" means
    // here. A regression that unrolled the script would light this up.
    expect(redis.zrangebyscore).not.toHaveBeenCalled();
    expect(redis.zrem).not.toHaveBeenCalled();
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('passes the retry set, the stream, the clock and the batch cap', async () => {
    await queue.promoteDue(7);

    expect(redis.mailPromoteDue).toHaveBeenCalledWith(
      KEYS.mail.retry(),
      KEYS.mail.stream(),
      expect.any(Number),
      7,
    );
  });

  it('reports how many the script moved', async () => {
    redis.mailPromoteDue.mockResolvedValue(3);
    await expect(queue.promoteDue(10)).resolves.toBe(3);
  });

  it('promotes nothing when nothing is due', async () => {
    redis.mailPromoteDue.mockResolvedValue(0);
    await expect(queue.promoteDue(10)).resolves.toBe(0);
  });
});

describe('MailQueue.deadLetter — the debt is recorded before the message is retired', () => {
  /**
   * Retiring a message and recording what it owes are now one script, and that is the
   * fix for the second crash window.
   *
   * Before, `deadLetter` wrote the DLQ entry and acked + deleted the source, and the
   * WORKER ran the compensation on the following line. By then the message was fully
   * retired, so a crash in that gap left the user charged for mail that no longer
   * existed anywhere — and nothing recorded that a refund was outstanding. The undo
   * list was inside the DLQ entry, but nothing reads the DLQ.
   */
  it('retires and records in ONE round trip', async () => {
    await queue.deadLetter('4-0', { ...job, attempts: 5 }, 'ETIMEDOUT');

    expect(redis.mailDeadLetter).toHaveBeenCalledTimes(1);
    // Not issued separately any more; a regression that split them would reopen the
    // window between retiring the message and recording the debt.
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(redis.xack).not.toHaveBeenCalled();
  });

  it('passes the DLQ, the undo stream and the work stream, with the reason and the cap', async () => {
    await queue.deadLetter('4-0', { ...job, attempts: 5 }, 'ETIMEDOUT');

    const args = redis.mailDeadLetter.mock.calls[0] as unknown[];
    expect(args[0]).toBe(KEYS.mail.dlq());
    expect(args[1]).toBe(KEYS.mail.undo());
    expect(args[2]).toBe(KEYS.mail.stream());
    expect(args).toContain('ETIMEDOUT');
    expect(args).toContain('4-0');
    // Approximate trimming: exact trimming costs more than the precision is worth
    // for an audit log.
    expect(args).toContain(MAIL_QUEUE.DLQ_MAX_LEN);
  });

  it('carries the undo list, so the refund survives this process dying', async () => {
    await queue.deadLetter('4-0', job, 'reason');

    const args = redis.mailDeadLetter.mock.calls[0] as unknown[];
    // The job fixture parks a `cache.refund`. It has to reach the script as data —
    // that is the whole reason a compensation is a descriptor and not a closure.
    expect(args).toContain(JSON.stringify(job.undo));
  });
});

describe('MAIL_QUEUE tuning is internally consistent', () => {
  const KINDS = ['otp', 'password-reset', 'welcome', 'security-changed'];

  it('has a backoff entry for every retry it will make', () => {
    // The attempt count is derived from the ladder rather than declared beside it, so
    // this can no longer drift — but assert it anyway, because the derivation is the
    // thing that would be "simplified" back into two constants.
    for (const kind of KINDS) {
      expect(MAIL_QUEUE.backoffFor(kind)).toHaveLength(MAIL_QUEUE.maxAttemptsFor(kind) - 1);
    }
  });

  it('backs off monotonically', () => {
    for (const kind of KINDS) {
      const gaps = [...MAIL_QUEUE.backoffFor(kind)];
      expect(gaps).toEqual([...gaps].sort((a, b) => a - b));
    }
  });

  it('finishes every perishable retry inside the ten-minute life of a code', () => {
    // THE constraint this ladder exists to satisfy. The old single schedule put the
    // fifth attempt at ~17m35s against a code that dies at 10m, so the last two
    // attempts delivered a code that could not work — one OTP, mailed repeatedly,
    // the tail of it useless.
    const OTP_LIFETIME_MS = 10 * 60 * 1_000;

    for (const kind of ['otp', 'password-reset']) {
      const elapsed = MAIL_QUEUE.backoffFor(kind).reduce((sum, gap) => sum + gap, 0);
      expect(elapsed).toBeLessThan(OTP_LIFETIME_MS);
    }
  });

  it('still gives ordinary mail the patient ladder', () => {
    // The other half of the split: a welcome email is just as valuable delivered
    // fifteen minutes late, so shortening its retries would trade a real delivery for
    // nothing.
    const standard = MAIL_QUEUE.backoffFor('welcome');
    const perishable = MAIL_QUEUE.backoffFor('otp');

    expect(standard.at(-1)).toBeGreaterThan(perishable.at(-1) as number);
  });

  it('never schedules a zero-delay retry', () => {
    // This used to assert the opposite — that a perishable message retried
    // IMMEDIATELY — on the grounds that most SMTP failures are a dropped connection
    // that succeeds on repeat, and a ten-minute code cannot spend five seconds finding
    // that out.
    //
    // The premise was already handled a layer down. `MailSender.attemptDelivery` tries
    // the primary relay and, on `unreachable`, immediately tries the backup within the
    // SAME attempt — so a dropped connection is retried at once regardless of this
    // ladder. The zero rung duplicated that, and what it added was a fifth attempt on
    // a schedule documented as four, spent re-hitting a relay in the instant it
    // refused: no help against an outage, and actively wrong against a throttle.
    for (const kind of ['otp', 'password-reset', 'welcome']) {
      for (const wait of MAIL_QUEUE.backoffFor(kind)) {
        expect(wait).toBeGreaterThan(0);
      }
    }
  });

  it('gives a perishable message four attempts, all inside the code’s lifetime', () => {
    // Four, not five — the count is derived from the ladder, so this is the assertion
    // that the ladder and the documented shape agree.
    expect(MAIL_QUEUE.maxAttemptsFor('otp')).toBe(4);

    // And the last one still lands well inside OTP.TTL_SECONDS, which is the property
    // the perishable ladder exists for: an attempt that delivers an expired code is
    // mail the recipient cannot use.
    const elapsed = MAIL_QUEUE.backoffFor('otp').reduce((sum, wait) => sum + wait, 0);
    expect(elapsed).toBeLessThan(10 * 60_000);
  });

  it('waits longer to reclaim than the transport waits to time out', () => {
    // The transport's socketTimeout is 20s and a message can queue behind others for
    // a pooled connection. A reclaim threshold below that would steal a message from
    // a healthy worker and send it twice.
    expect(MAIL_QUEUE.RECLAIM_AFTER_MS).toBeGreaterThan(20_000);
  });
});

describe('MailQueue.ack — the stream must not grow without bound', () => {
  it('deletes the entry as well as acknowledging it', async () => {
    // `XACK` removes an entry from the group's PENDING list, not from the stream. A
    // Stream is a log: an acked entry sits in it forever, so an ack-only queue grows
    // by one entry per email the service has ever sent and never reclaims the memory.
    //
    // This was measured, not theorised: one register request left `XLEN mail:stream`
    // at 1 with `pending` at 0 — delivered, acknowledged, still occupying the stream.
    await queue.ack('1-0');

    expect(redis.xack).toHaveBeenCalledWith(KEYS.mail.stream(), KEYS.mail.group(), '1-0');
    expect(redis.xdel).toHaveBeenCalledWith(KEYS.mail.stream(), '1-0');
  });

  it('acknowledges BEFORE deleting', async () => {
    // Deleting first would drop the entry while it was still pending for this
    // consumer, leaving a PEL reference to something that no longer exists.
    await queue.ack('1-0');
    expect(order.indexOf('xack')).toBeLessThan(order.indexOf('xdel'));
  });

  it('is used by every terminal path, so nothing is left behind', async () => {
    // A path that acks must also delete, or the stream grows until someone notices
    // months later. `scheduleRetry` still does both through `ack`; `deadLetter` does
    // them inside its script, so the entry id it is given is the assertion there.
    await queue.scheduleRetry('2-0', job, 1_000);
    expect(redis.xdel).toHaveBeenCalledWith(KEYS.mail.stream(), '2-0');

    redis.xdel.mockClear();
    await queue.deadLetter('3-0', job, 'reason');
    expect(redis.mailDeadLetter.mock.calls[0]).toContain('3-0');
  });
});
