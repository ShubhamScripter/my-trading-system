import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheService, QuotaService } from '../../redis';
import { makeQuota } from '../harness';
import { MAIL_QUEUE } from '../../src/mail/mail.constants';
import type { MailQueue } from '../../src/mail/mail.queue';
import type { MailSender, SendOutcome } from '../../src/mail/mail.sender';
import { MailUndoRegistry } from '../../src/mail/mail.undo';
import { MailWorker } from '../../src/mail/mail.worker';
import type { MailJob } from '../../src/mail/mail.types';

/**
 * The worker's decisions: ack, retry, or dead-letter — and whether the user gets
 * their budget back.
 *
 * Every branch is a function of one `SendOutcome`, which is exactly why `MailSender`
 * returns an outcome rather than throwing. A double returning one of the four values
 * drives the whole matrix without a relay, a database or a Redis.
 *
 * The loop itself is not exercised here. `tick` is driven directly, because a `while`
 * loop with a five-second blocking read is not something a unit test should try to
 * step through — and the decisions, not the looping, are where the defects would be.
 */

const job: MailJob = {
  id: 'job-1',
  kind: 'otp',
  body: { to: 'ada@example.test', subject: 'code', text: 'code', html: '<p>code</p>' },
  undo: [{ kind: 'cache.refund', key: 'rate:otp-send' }],
  attempts: 0,
  queuedAt: new Date().toISOString(),
};

function createQueue() {
  return {
    onModuleInit: vi.fn(),
    enqueue: vi.fn(),
    claim: vi.fn().mockResolvedValue([]),
    reclaimStalled: vi.fn().mockResolvedValue([]),
    ack: vi.fn().mockResolvedValue(undefined),
    scheduleRetry: vi.fn().mockResolvedValue(undefined),
    promoteDue: vi.fn().mockResolvedValue(0),
    deadLetter: vi.fn().mockResolvedValue(undefined),
    // The compensation stream. Empty by default so every spec about DELIVERY
    // describes only delivery; the specs that are about refunds fill it in.
    claimUndo: vi.fn().mockResolvedValue([]),
    ackUndo: vi.fn().mockResolvedValue(undefined),
    depth: vi.fn().mockResolvedValue({ pending: 0, retrying: 0, dead: 0 }),
  };
}

let queue: ReturnType<typeof createQueue>;
let sender: { send: ReturnType<typeof vi.fn> };
let cache: {
  clear: ReturnType<typeof vi.fn>;
  refund: ReturnType<typeof vi.fn>;
  clearOrThrow: ReturnType<typeof vi.fn>;
  refundOrThrow: ReturnType<typeof vi.fn>;
  setIfAbsent: ReturnType<typeof vi.fn>;
};
let undo: MailUndoRegistry;
let worker: MailWorker;

/**
 * Drive one cycle without starting the loop.
 *
 * `running` is set directly because `deliverAll` checks it before every message — that
 * is what lets shutdown abandon a batch mid-way and leave the rest pending. Starting
 * the real loop instead would mean a `while` around a five-second blocking read, which
 * a unit test cannot step through; and the decisions, not the looping, are where the
 * defects would be.
 */
function tick(): Promise<void> {
  const internals = worker as unknown as { running: boolean; tick(): Promise<void> };
  internals.running = true;
  return internals.tick();
}

/** The next send resolves to this outcome. */
function sends(outcome: SendOutcome): void {
  sender.send.mockResolvedValue(outcome);
}

beforeEach(() => {
  queue = createQueue();
  sender = { send: vi.fn() };
  cache = {
    clear: vi.fn().mockResolvedValue(undefined),
    refund: vi.fn().mockResolvedValue(undefined),
    // The registry uses the `OrThrow` variants deliberately: the fail-open ones
    // reported success while nothing had been refunded, which is the false positive
    // that made retrying compensations pointless.
    clearOrThrow: vi.fn().mockResolvedValue(undefined),
    refundOrThrow: vi.fn().mockResolvedValue(undefined),
    // The once-only claim for non-idempotent compensations. `true` = this delivery
    // won it and may run the handler.
    setIfAbsent: vi.fn().mockResolvedValue(true),
  };
  // A REAL registry over a doubled cache, so the compensation is genuinely applied
  // rather than merely requested.
  undo = new MailUndoRegistry(cache as unknown as CacheService, makeQuota() as unknown as QuotaService);

  worker = new MailWorker(
    queue as unknown as MailQueue,
    sender as unknown as MailSender,
    undo,
  );
});

describe('a successful delivery', () => {
  beforeEach(() => {
    queue.claim.mockResolvedValue([{ entryId: '1-0', job }]);
  });

  it('acks the message and nothing else', async () => {
    sends({ status: 'sent', detail: '250 OK' });
    await tick();

    expect(queue.ack).toHaveBeenCalledWith('1-0');
    expect(queue.scheduleRetry).not.toHaveBeenCalled();
    expect(queue.deadLetter).not.toHaveBeenCalled();
  });

  it('does not compensate — the user got their mail', async () => {
    sends({ status: 'sent', detail: '250 OK' });
    await tick();

    expect(cache.refund).not.toHaveBeenCalled();
  });

  it('treats the console transport as delivered', async () => {
    // In development the code IS available to the developer, so refunding every
    // budget would make the send limits untestable.
    sends({ status: 'skipped', detail: 'console transport' });
    await tick();

    expect(queue.ack).toHaveBeenCalledWith('1-0');
    expect(cache.refund).not.toHaveBeenCalled();
  });
});

describe('a retryable failure', () => {
  beforeEach(() => {
    queue.claim.mockResolvedValue([{ entryId: '1-0', job }]);
    sends({ status: 'unreachable', detail: 'ETIMEDOUT' });
  });

  it('schedules a retry rather than dead-lettering', async () => {
    await tick();

    expect(queue.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(queue.deadLetter).not.toHaveBeenCalled();
  });

  it('does NOT compensate yet — the message may still be delivered', async () => {
    // Refunding on the first failure would give the budget back and then deliver the
    // code anyway, which is a free extra send per transient blip.
    await tick();
    expect(cache.refund).not.toHaveBeenCalled();
  });

  it('increments the attempt count and records the error', async () => {
    await tick();

    const [, retried] = queue.scheduleRetry.mock.calls[0] as [string, MailJob, number];
    expect(retried.attempts).toBe(1);
    expect(retried.lastError).toBe('ETIMEDOUT');
  });

  it('uses the configured backoff for the attempt just made', async () => {
    await tick();

    const [, , delay] = queue.scheduleRetry.mock.calls[0] as [string, MailJob, number];
    expect(delay).toBe(MAIL_QUEUE.backoffAfter('otp', 1));
  });

  it('backs off further on a later attempt', async () => {
    queue.claim.mockResolvedValue([{ entryId: '1-0', job: { ...job, attempts: 2 } }]);
    await tick();

    const [, , delay] = queue.scheduleRetry.mock.calls[0] as [string, MailJob, number];
    expect(delay).toBe(MAIL_QUEUE.backoffAfter('otp', 3));
  });

  it('preserves queuedAt across retries, so message age is the age of the promise', async () => {
    await tick();

    const [, retried] = queue.scheduleRetry.mock.calls[0] as [string, MailJob];
    expect(retried.queuedAt).toBe(job.queuedAt);
  });
});

describe('a rejected recipient is terminal', () => {
  it('dead-letters immediately, without retrying', async () => {
    // A 550 for a mailbox that does not exist will be a 550 on every retry and on
    // every relay. Retrying only doubles the reputation damage — the same reasoning
    // the transport's own failover applies.
    queue.claim.mockResolvedValue([{ entryId: '1-0', job }]);
    sends({ status: 'rejected', detail: '550 no such user' });

    await tick();

    expect(queue.deadLetter).toHaveBeenCalledTimes(1);
    expect(queue.scheduleRetry).not.toHaveBeenCalled();
  });

  it('hands the compensation to the queue, which records it durably', async () => {
    queue.claim.mockResolvedValue([{ entryId: '1-0', job }]);
    sends({ status: 'rejected', detail: '550 no such user' });

    await tick();

    // The worker no longer runs the refund itself. It used to, on the line after
    // `deadLetter` — which had already acked and deleted the source entry, so a crash
    // in that gap left the user charged for mail that no longer existed anywhere.
    // `deadLetter` now writes the debt inside the same script that retires the
    // message, and `settleUndo` drains it. The handoff is what this asserts.
    const [, dead] = queue.deadLetter.mock.calls[0] as [string, MailJob, string];
    expect(dead.undo).toEqual(job.undo);
    expect(cache.refundOrThrow).not.toHaveBeenCalled();
  });
});

describe('an expired code is terminal', () => {
  /**
   * The other half of the "one OTP resent forever" fix.
   *
   * `MailSender` refuses to hand an expired code to a relay. The worker's job is to
   * believe it: retrying would put the same dead code back on the queue to be refused
   * again on every remaining rung, which is the loop the user reported seeing.
   */
  beforeEach(() => {
    queue.claim.mockResolvedValue([{ entryId: '1-0', job }]);
    sends({ status: 'expired', detail: 'content expired 12s ago' });
  });

  it('dead-letters instead of retrying a code that can no longer work', async () => {
    await tick();

    expect(queue.deadLetter).toHaveBeenCalledTimes(1);
    expect(queue.scheduleRetry).not.toHaveBeenCalled();
  });

  it('records the refund owed — this was OUR outage, not the user\'s attempt', async () => {
    // The distinction from a rejected recipient. A bad address is nothing we owe
    // anything for; a code that expired in our queue was charged against the user's
    // budget for a message that never left the building. Five of those and they are
    // locked out of their own account for an hour, having seen no error at any point.
    await tick();

    const [, dead] = queue.deadLetter.mock.calls[0] as [string, MailJob, string];
    expect(dead.undo).toEqual(job.undo);
  });

  it('keeps the reason on the dead-letter entry', async () => {
    await tick();

    const [, dead, reason] = queue.deadLetter.mock.calls[0] as [string, MailJob, string];
    expect(reason).toBe('content expired 12s ago');
    expect(dead.lastError).toBe('content expired 12s ago');
  });

  it('is terminal on the FIRST attempt, with rungs still unspent', async () => {
    // Nothing about "attempts remaining" enters into it. The content is dead, so every
    // remaining rung would deliver something useless.
    await tick();

    const attempted = (queue.deadLetter.mock.calls[0] as [string, MailJob, string])[1];
    expect(attempted.attempts).toBe(1);
    expect(attempted.attempts).toBeLessThan(MAIL_QUEUE.maxAttemptsFor('otp'));
  });
});

describe('exhausting every attempt', () => {
  beforeEach(() => {
    queue.claim.mockResolvedValue([
      { entryId: '1-0', job: { ...job, attempts: MAIL_QUEUE.maxAttemptsFor('otp') - 1 } },
    ]);
    sends({ status: 'unreachable', detail: 'ECONNREFUSED' });
  });

  it('dead-letters on the final attempt', async () => {
    await tick();

    expect(queue.deadLetter).toHaveBeenCalledTimes(1);
    expect(queue.scheduleRetry).not.toHaveBeenCalled();
  });

  it('carries the compensations onto the dead-letter — THE reason the undo is data', async () => {
    // This is the failure the whole change exists to close. The user was charged a
    // send from their budget; if this refund does not happen they are one attempt
    // poorer for mail that never arrived, and five of those locks them out of their
    // own account for an hour with no error shown at any point.
    //
    // What changed is WHERE it runs, not whether: the debt goes onto `mail:undo`
    // atomically with the retirement, and `settleUndo` applies it — see the suite
    // below, which asserts a failed refund is retried rather than logged once.
    await tick();

    const [, dead] = queue.deadLetter.mock.calls[0] as [string, MailJob, string];
    expect(dead.undo).toEqual(job.undo);
  });

  it('runs EVERY compensation, not just the first', async () => {
    // The login path parks two: a cooldown to clear and a budget slot to refund.
    queue.claim.mockResolvedValue([
      {
        entryId: '1-0',
        job: {
          ...job,
          attempts: MAIL_QUEUE.maxAttemptsFor('otp') - 1,
          undo: [
            { kind: 'cache.clear' as const, key: 'cooldown:x' },
            { kind: 'cache.refund' as const, key: 'rate:otp-send' },
          ],
        },
      },
    ]);

    await tick();

    const [, dead] = queue.deadLetter.mock.calls[0] as [string, MailJob, string];
    expect(dead.undo).toHaveLength(2);
  });

  it('records the final error on the dead-lettered job', async () => {
    await tick();

    const [, dead, reason] = queue.deadLetter.mock.calls[0] as [string, MailJob, string];
    expect(dead.attempts).toBe(MAIL_QUEUE.maxAttemptsFor('otp'));
    expect(reason).toBe('ECONNREFUSED');
  });
});

describe('the cycle order', () => {
  it('drains what a dead worker abandoned BEFORE claiming new work', async () => {
    // A message already attempted carries an older promise than one just enqueued, so
    // a crash backlog drains first. Returning early also stops a large backlog from
    // being interleaved with new mail.
    queue.reclaimStalled.mockResolvedValue([{ entryId: '9-0', job }]);
    sends({ status: 'sent', detail: '250 OK' });

    await tick();

    expect(queue.reclaimStalled).toHaveBeenCalled();
    expect(queue.claim).not.toHaveBeenCalled();
  });

  it('promotes due retries before claiming, so they are not starved', async () => {
    await tick();

    expect(queue.promoteDue).toHaveBeenCalled();
    expect(queue.claim).toHaveBeenCalled();
  });
});

describe('a sender that throws is treated as retryable', () => {
  it('does not ack a message nobody managed to attempt', async () => {
    // `send` is written not to throw, so this is a bug rather than an SMTP failure.
    // Acking would silently drop the message; retrying is the safe reading.
    queue.claim.mockResolvedValue([{ entryId: '1-0', job }]);
    sender.send.mockRejectedValue(new Error('bug in the sender'));

    await tick();

    expect(queue.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(queue.ack).not.toHaveBeenCalled();
  });
});

describe('MailUndoRegistry', () => {
  it('refuses to register two handlers for one kind', () => {
    // Which one wins would otherwise depend on module initialisation order, and a
    // compensation running the wrong way round is worse than one not running.
    expect(() => undo.register('cache.refund', async () => undefined)).toThrow(
      /already registered/i,
    );
  });

  it('survives a handler that throws, and still runs the others', async () => {
    cache.clearOrThrow.mockRejectedValue(new Error('redis down'));

    const settled = await undo.runAll(
      [
        { kind: 'cache.clear', key: 'a' },
        { kind: 'cache.refund', key: 'b' },
      ],
      { jobId: 'j', kind: 'otp' },
    );

    // The second compensation must not be lost because the first failed.
    expect(cache.refundOrThrow).toHaveBeenCalledWith('b');
    // ...and the record must NOT be settled, because one of them still is not.
    expect(settled).toBe(false);
  });

  it('reports success only when every compensation actually applied', async () => {
    const settled = await undo.runAll(
      [
        { kind: 'cache.clear', key: 'a' },
        { kind: 'cache.refund', key: 'b' },
      ],
      { jobId: 'j', kind: 'otp' },
    );

    expect(settled).toBe(true);
  });

  it('skips a non-idempotent compensation whose claim was already taken', async () => {
    // A redelivery. `cache.refund` is a DECR, so running it a second time hands back
    // two slots for one failed send — a way to mint quota by breaking delivery. The
    // claim is what makes at-most-once true across retries.
    cache.setIfAbsent.mockResolvedValue(false);

    const settled = await undo.runAll([{ kind: 'cache.refund', key: 'b' }], {
      jobId: 'j',
      kind: 'otp',
    });

    expect(cache.refundOrThrow).not.toHaveBeenCalled();
    // Still settled: it was applied by the delivery that won the claim.
    expect(settled).toBe(true);
  });

  it('does not claim for an idempotent compensation', async () => {
    // `cache.clear` is a DEL. Repeating it deletes nothing, so a claim would only add
    // a Redis round trip and a way for the compensation to be skipped after a crash.
    await undo.runAll([{ kind: 'cache.clear', key: 'a' }], { jobId: 'j', kind: 'otp' });

    expect(cache.setIfAbsent).not.toHaveBeenCalled();
    expect(cache.clearOrThrow).toHaveBeenCalledWith('a');
  });

  it('does not throw when a kind has no handler', async () => {
    // A missing handler means a lost refund, which is logged loudly — but throwing
    // here would happen inside the worker's failure path and turn one lost refund
    // into a stalled queue.
    await expect(
      undo.runAll([{ kind: 'registration.refund-otp-send', registrationId: 'r1' }], {
        jobId: 'j',
        kind: 'otp',
      }),
      // `false`, not a throw: the record stays pending and is retried, which is right
      // for a deployment where `auth` has not registered its handler yet.
    ).resolves.toBe(false);
  });
});

/**
 * ═══ THE COMPENSATION IS RETRIED UNTIL IT SETTLES ═══════════════════════════
 *
 * The second crash window, and the reason `mail:undo` exists.
 *
 * `deadLetter` used to ack and delete the source entry, and the worker ran the undo
 * list on the NEXT line. A crash in between left the user charged for mail that no
 * longer existed in any structure — nothing recorded that a refund was owed, so
 * nothing could ever pay it. And when a compensation merely FAILED, it was logged once
 * and forgotten, which had the same outcome by a slower route.
 *
 * Both are closed by the same move: the debt is written durably in the script that
 * retires the message, and a record is acked only once every compensation in it has
 * settled. An unsettled record stays pending, and `XAUTOCLAIM` brings it back — the
 * ack IS the retry mechanism.
 */
describe('MailWorker.settleUndo', () => {
  const record = {
    entryId: 'u-1',
    jobId: 'job-1',
    kind: 'otp',
    undo: [{ kind: 'cache.clear' as const, key: 'cooldown:x' }],
  };

  it('applies the compensations it claims', async () => {
    queue.claimUndo.mockResolvedValue([record]);

    await tick();

    expect(cache.clearOrThrow).toHaveBeenCalledWith('cooldown:x');
  });

  it('acks the record once everything in it settled', async () => {
    queue.claimUndo.mockResolvedValue([record]);

    await tick();

    expect(queue.ackUndo).toHaveBeenCalledWith('u-1');
  });

  it('leaves the record PENDING when a compensation fails, so it is retried', async () => {
    // The assertion that matters. Acking here would discard the debt exactly as the
    // old log-and-continue did; not acking is what turns `XAUTOCLAIM` into the retry.
    queue.claimUndo.mockResolvedValue([record]);
    cache.clearOrThrow.mockRejectedValue(new Error('redis down'));

    await tick();

    expect(queue.ackUndo).not.toHaveBeenCalled();
  });

  it('does not report success when the refund never actually applied', async () => {
    // The false positive that made retrying pointless before. `CacheService.refund`
    // catches its own errors, so a Redis-down compensation returned normally and the
    // registry logged 'undelivered mail compensated' having refunded nothing. The
    // registry uses `refundOrThrow` precisely so that failure is visible here.
    queue.claimUndo.mockResolvedValue([
      { ...record, undo: [{ kind: 'cache.refund' as const, key: 'rate:otp-send' }] },
    ]);
    cache.refundOrThrow.mockRejectedValue(new Error('redis down'));

    await tick();

    expect(queue.ackUndo).not.toHaveBeenCalled();
  });

  it('runs before delivery, so a wrongly-charged user is unblocked first', async () => {
    // A user holding a budget they were charged for mail that never arrived cannot
    // retry at all, and settling costs a handful of Redis commands.
    queue.claimUndo.mockResolvedValue([record]);

    await tick();

    expect(queue.claimUndo).toHaveBeenCalled();
  });
});

describe('MailWorker.tick — promotion is never skipped', () => {
  it('promotes due retries even when there is stalled work to reclaim', async () => {
    // `promoteDue` used to sit AFTER the stalled-work check, which returned early. A
    // persistent reclaimable backlog — exactly the situation a retry ladder exists for
    // — therefore meant no parked retry was ever promoted, and they sat in the sorted
    // set indefinitely while the worker looked busy.
    queue.reclaimStalled.mockResolvedValue([{ entryId: '9-0', job }]);
    sends({ status: 'sent', detail: 'ok' });

    await tick();

    expect(queue.promoteDue).toHaveBeenCalled();
  });
});
