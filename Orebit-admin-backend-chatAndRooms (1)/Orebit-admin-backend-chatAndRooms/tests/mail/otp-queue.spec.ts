import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OtpQueueService } from '../../src/mail/otp-queue.service';
import { KEYS } from '../../redis';

/**
 * ═══ THE DURABLE OTP QUEUE ═════════════════════════════════════════════════
 *
 * These tests own the property that used to live in tests/auth/login.spec.ts: an SMTP
 * outage must not become a self-inflicted admin lockout.
 *
 * It moved because the mechanism moved. `LoginService` used to send inline and branch
 * on the outcome; it now enqueues and returns, so the compensation for a failed
 * delivery is this service's job. The stakes are unchanged and worth restating: the
 * emailed code is a MANDATORY second factor here, and the password-recovery flow was
 * removed, so an admin who cannot receive a code has no way in at all. Every refund
 * below exists because getting it wrong locks somebody out of the tool they administer
 * the platform with.
 *
 * ─── A fake Redis, not a real one ──────────────────────────────────────────
 *
 * The queue is four Redis keys and the transitions between them, so the double
 * implements just those commands over plain JavaScript maps. That is enough to assert
 * every ordering property here. What it cannot check is the Lua promotion script's
 * atomicity, which is a property of Redis rather than of this file and is exercised by
 * the end-to-end run.
 */

/**
 * A minimal in-memory stand-in for the durable client.
 *
 * ─── Why this models TWO connections over ONE server ───────────────────────
 *
 * `OtpQueueService` now writes through a connection of its own (`duplicate()`) while
 * the worker loops keep the injected one. The double mirrors that: `duplicate()`
 * returns a DISTINCT client object with its own spies, backed by the SAME maps — which
 * is exactly what two ioredis connections to one Redis are. Sharing the maps is what
 * lets the existing data assertions below stay untouched; separating the objects is
 * what lets a test prove the producer is not the connection the workers block on.
 *
 * What the double deliberately does NOT model is ioredis's per-connection command
 * queueing, which is the mechanism the split exists to escape. That is a property of
 * the real client, so it is proved against a real Redis rather than asserted here.
 */
function makeRedis() {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const zsets = new Map<string, Map<string, number>>();

  const listOf = (k: string) => {
    if (!lists.has(k)) lists.set(k, []);
    return lists.get(k) as string[];
  };

  /** One connection's command surface. Every call lands on the shared maps above. */
  const connection = () => ({
    strings,
    lists,
    zsets,

    set: vi.fn(async (k: string, v: string, _mode?: string, _ttl?: number) => {
      strings.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => strings.get(k) ?? null),
    del: vi.fn(async (k: string) => (strings.delete(k) ? 1 : 0)),
    lpush: vi.fn(async (k: string, v: string) => listOf(k).unshift(v)),
    lrem: vi.fn(async (k: string, _n: number, v: string) => {
      const l = listOf(k);
      const i = l.indexOf(v);
      if (i >= 0) l.splice(i, 1);
      return 1;
    }),
    rpoplpush: vi.fn(async (src: string, dst: string) => {
      const v = listOf(src).pop();
      if (v === undefined) return null;
      listOf(dst).unshift(v);
      return v;
    }),
    brpoplpush: vi.fn(async (src: string, dst: string) => {
      const v = listOf(src).pop();
      if (v === undefined) return null;
      listOf(dst).unshift(v);
      return v;
    }),
    zadd: vi.fn(async (k: string, score: number, member: string) => {
      if (!zsets.has(k)) zsets.set(k, new Map());
      (zsets.get(k) as Map<string, number>).set(member, score);
      return 1;
    }),
    eval: vi.fn(async () => 0),
    connect: vi.fn(async () => undefined),
    quit: vi.fn(async () => 'OK'),
  });

  const worker = connection() as ReturnType<typeof connection> & {
    duplicate: ReturnType<typeof vi.fn>;
    producer: ReturnType<typeof connection>;
  };
  const producer = connection();
  worker.producer = producer;
  worker.duplicate = vi.fn(() => producer);
  return worker;
}

function build(sendOutcome: 'sent' | 'rejected' | 'unreachable' = 'sent') {
  const redis = makeRedis();
  const mail = { sendLoginOtp: vi.fn().mockResolvedValue(sendOutcome) };
  const cache = {
    refund: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const db = {
    invalidateChallenge: vi.fn().mockResolvedValue(undefined),
    refundOtpSent: vi.fn().mockResolvedValue(undefined),
  };

  const service = new OtpQueueService(
    redis as never,
    mail as never,
    cache as never,
    db as never,
  );

  return { service, redis, mail, cache, db };
}

const JOB = {
  adminId: '01920000-0000-7000-8000-000000000001',
  challengeId: '01920000-0000-7000-8000-0000000000c1',
  attemptId: '01920000-0000-7000-8000-0000000000a1',
  emailLower: 'admin@orebit.io',
  to: 'Admin@Orebit.io',
  code: '123456',
  minutesValid: 10,
  validUntil: new Date(Date.now() + 10 * 60 * 1000),
};

/** Reach the private worker step for one job, without starting the loops. */
function processJob(service: OtpQueueService, jobId: string): Promise<void> {
  return (service as unknown as { process(id: string): Promise<void> }).process(jobId);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueue', () => {
  it('stores the job and puts it straight on the active list', async () => {
    const { service, redis } = build();

    const jobId = await service.enqueue(JOB);

    expect(redis.strings.has(KEYS.otpQueue.job(jobId))).toBe(true);
    expect(redis.lists.get(KEYS.otpQueue.active())).toEqual([jobId]);
  });

  /**
   * The first attempt has a delay of zero, so routing it through the delayed sorted
   * set would make the very first code wait for a promotion sweep it does not need —
   * adding latency to the common path to serve the rare one.
   */
  it('does not route the first attempt through the delayed set', async () => {
    const { service, redis } = build();

    await service.enqueue(JOB);

    expect(redis.zadd).not.toHaveBeenCalled();
  });

  /**
   * === THE CODE IS NOT READABLE IN STORAGE ==================================
   *
   * This is the only place in the service where a live one-time code is written down
   * at all. Everywhere else it exists as a peppered digest and the plaintext dies with
   * the request. A dump of `redis-durable` — AOF files in a Docker volume, a far
   * softer target than Postgres — must not hand over every in-flight sign-in code.
   */
  it('never stores the code in the clear', async () => {
    const { service, redis } = build();

    const jobId = await service.enqueue(JOB);
    const stored = redis.strings.get(KEYS.otpQueue.job(jobId)) as string;

    expect(stored).not.toContain(JOB.code);
    expect(stored).not.toContain(JOB.to);
    expect(stored).not.toContain(JOB.emailLower);
  });

  /** The ids ARE in the clear, deliberately — they are the AAD, and the envelope
   *  cannot be opened without them. Two opaque UUIDs disclose nothing worth hiding. */
  it('stores the binding ids as an authenticated header', async () => {
    const { service, redis } = build();

    const jobId = await service.enqueue(JOB);
    const stored = redis.strings.get(KEYS.otpQueue.job(jobId)) as string;

    expect(stored.startsWith(`${JOB.adminId}:${JOB.challengeId}:`)).toBe(true);
  });

  /** A TTL, so a job nothing ever processes cannot hold a live code forever. */
  it('bounds how long the payload can live', async () => {
    const { service, redis } = build();

    await service.enqueue(JOB);

    // On the PRODUCER connection: `enqueue` writes there now. Same key, same
    // envelope, same `EX` mode, same TTL - only the socket changed.
    const [, , mode, ttl] = redis.producer.set.mock.calls[0] as [
      string,
      string,
      string | undefined,
      number | undefined,
    ];
    expect(mode).toBe('EX');
    expect(ttl).toBeGreaterThan(0);
  });
});

describe('the AAD binding', () => {
  /**
   * ═══ WHY THE ENVELOPE IS BOUND TO ITS OWN KEY ══════════════════════════════
   *
   * Without the AAD a ciphertext is a free-floating blob. Anyone who can write to
   * Redis could copy the envelope stored under one job id onto another job id, and the
   * worker would decrypt it happily and email admin A's code to whatever recipient the
   * job it replaced named. The tag covers the identity as well as the contents, so a
   * payload found under the wrong key fails authentication instead of being honoured.
   */
  it('refuses a payload moved to a different job id', async () => {
    const { service, redis, mail } = build();

    const jobId = await service.enqueue(JOB);
    const envelope = redis.strings.get(KEYS.otpQueue.job(jobId)) as string;

    // Same bytes, different key — exactly what an attacker with write access does.
    redis.strings.set(KEYS.otpQueue.job('some-other-job-id'), envelope);
    await processJob(service, 'some-other-job-id');

    expect(mail.sendLoginOtp).not.toHaveBeenCalled();
  });

  /** Editing the plaintext header breaks the tag too — it is authenticated, not
   *  merely stored alongside. */
  it('refuses a payload whose header ids were edited', async () => {
    const { service, redis, mail } = build();

    const jobId = await service.enqueue(JOB);
    const envelope = redis.strings.get(KEYS.otpQueue.job(jobId)) as string;
    const sealed = envelope.split(':')[2] as string;

    redis.strings.set(
      KEYS.otpQueue.job(jobId),
      `01920000-0000-7000-8000-0000000000ff:${JOB.challengeId}:${sealed}`,
    );
    await processJob(service, jobId);

    expect(mail.sendLoginOtp).not.toHaveBeenCalled();
  });

  /** A truncated or corrupted blob is dropped rather than throwing — a worker loop
   *  that dies on one bad payload stops delivering everybody's codes. */
  it('drops an unreadable payload without throwing', async () => {
    const { service, redis, mail } = build();

    redis.strings.set(KEYS.otpQueue.job('bogus'), 'a:b:not-base64-at-all');

    await expect(processJob(service, 'bogus')).resolves.toBeUndefined();
    expect(mail.sendLoginOtp).not.toHaveBeenCalled();
  });

  /** And a missing payload is simply nothing to do. */
  it('drops a job whose payload has expired', async () => {
    const { service, mail } = build();

    await expect(processJob(service, 'never-stored')).resolves.toBeUndefined();
    expect(mail.sendLoginOtp).not.toHaveBeenCalled();
  });
});

describe('a successful delivery', () => {
  it('sends the code and discards the payload', async () => {
    const { service, redis, mail } = build('sent');

    const jobId = await service.enqueue(JOB);
    await processJob(service, jobId);

    expect(mail.sendLoginOtp).toHaveBeenCalledWith(JOB.to, JOB.code, JOB.minutesValid);
    expect(redis.strings.has(KEYS.otpQueue.job(jobId))).toBe(false);
  });

  it('refunds nothing', async () => {
    const { service, cache, db } = build('sent');

    const jobId = await service.enqueue(JOB);
    await processJob(service, jobId);

    expect(cache.refund).not.toHaveBeenCalled();
    expect(db.refundOtpSent).not.toHaveBeenCalled();
    expect(db.invalidateChallenge).not.toHaveBeenCalled();
  });
});

describe('an unreachable relay', () => {
  it('reschedules rather than giving up', async () => {
    const { service, redis } = build('unreachable');

    const jobId = await service.enqueue(JOB);
    await processJob(service, jobId);

    expect(redis.zadd).toHaveBeenCalledOnce();
    const [key, , member] = redis.zadd.mock.calls[0] as [string, number, string];
    expect(key).toBe(KEYS.otpQueue.delayed());
    expect(member).toBe(jobId);
  });

  /** Backoff, not a tight loop: 5s, then 30s, then 90s. A retry schedule that hammers
   *  a relay which is already refusing connections makes the outage worse. */
  it('backs off on the documented schedule', async () => {
    const delays: number[] = [];

    for (const expected of [5, 30, 90]) {
      const { service, redis } = build('unreachable');
      const jobId = await service.enqueue(JOB);

      // Walk the job forward one attempt at a time, re-processing each reschedule.
      for (let i = 0; i < delays.length + 1; i += 1) {
        await processJob(service, jobId);
      }

      const calls = redis.zadd.mock.calls as [string, number, string][];
      const last = calls[calls.length - 1] as [string, number, string];
      const seconds = Math.round((last[1] - Date.now()) / 1000);
      expect(seconds).toBeGreaterThanOrEqual(expected - 2);
      expect(seconds).toBeLessThanOrEqual(expected + 2);
      delays.push(expected);
    }
  });

  /** Nothing is refunded while retries remain — the send may still succeed, and
   *  refunding early then re-charging would let the quota drift. */
  it('refunds nothing while attempts remain', async () => {
    const { service, cache, db } = build('unreachable');

    const jobId = await service.enqueue(JOB);
    await processJob(service, jobId);

    expect(cache.refund).not.toHaveBeenCalled();
    expect(db.invalidateChallenge).not.toHaveBeenCalled();
  });
});

describe('when every attempt has failed', () => {
  /** Drive the job through all four scheduled attempts. */
  async function exhaust() {
    const built = build('unreachable');
    const jobId = await built.service.enqueue(JOB);
    for (let i = 0; i < 4; i += 1) await processJob(built.service, jobId);
    return { ...built, jobId };
  }

  it('stops retrying after the fourth attempt', async () => {
    const { mail } = await exhaust();
    expect(mail.sendLoginOtp).toHaveBeenCalledTimes(4);
  });

  /**
   * ═══ THE COMPENSATION, WHICH IS THE WHOLE POINT ════════════════════════════
   *
   * Everything `LoginService` charged optimistically at enqueue comes back. Without
   * this, an SMTP outage spends the admin's send budget on codes that never left the
   * process — they see success, no code arrives, they retry, and each retry costs a
   * slot they cannot see being spent. Five retries and the sign-in is dead, on an
   * account whose only way in is that emailed code, and the damage outlasts the outage
   * that caused it.
   */
  it('refunds both rolling quotas', async () => {
    const { cache } = await exhaust();

    expect(cache.refund).toHaveBeenCalledWith(KEYS.rate.loginOtpShort(JOB.emailLower));
    expect(cache.refund).toHaveBeenCalledWith(KEYS.rate.loginOtpDaily(JOB.emailLower));
  });

  it('refunds the per-attempt send counter', async () => {
    const { db } = await exhaust();
    expect(db.refundOtpSent).toHaveBeenCalledWith(JOB.attemptId);
  });

  /**
   * The cooldown is CLEARED, not refunded — it is a wait, not a counter. Leaving it
   * running would make the admin sit out sixty seconds before they could ask for the
   * replacement code this very failure made necessary.
   */
  it('clears the resend cooldown', async () => {
    const { cache } = await exhaust();
    expect(cache.clear).toHaveBeenCalledWith(KEYS.rate.loginOtpCooldown(JOB.emailLower));
  });

  /**
   * And the challenge is retired. A live challenge for a code that was never
   * delivered is a trap: the client polls `state`, sees a live OTP window, and waits
   * out ten minutes for mail that is not coming.
   */
  it('invalidates the challenge', async () => {
    const { db } = await exhaust();
    expect(db.invalidateChallenge).toHaveBeenCalledWith(JOB.challengeId);
  });

  it('discards the payload', async () => {
    const { redis, jobId } = await exhaust();
    expect(redis.strings.has(KEYS.otpQueue.job(jobId))).toBe(false);
  });
});

describe('a rejected recipient', () => {
  /**
   * ═══ TERMINAL ON THE FIRST ATTEMPT, AND NOT REFUNDED ═══════════════════════
   *
   * The relay answered. It read the recipient and refused it, and it will refuse the
   * same address next time — so retrying delivers nothing and spends our sending
   * reputation three more times for it. `MailService` already declines to try the
   * backup relay for exactly this reason.
   *
   * And the quotas are NOT given back, which is the asymmetry worth being deliberate
   * about: refunding would hand an admin whose address is permanently undeliverable an
   * unlimited supply of sends against a mailbox that can never receive — the one
   * direction these quotas exist to bound. The address is the problem, not our relay.
   */
  it('does not retry', async () => {
    const { service, mail, redis } = build('rejected');

    const jobId = await service.enqueue(JOB);
    await processJob(service, jobId);

    expect(mail.sendLoginOtp).toHaveBeenCalledOnce();
    expect(redis.zadd).not.toHaveBeenCalled();
  });

  it('does NOT refund the quotas', async () => {
    const { service, cache, db } = build('rejected');

    const jobId = await service.enqueue(JOB);
    await processJob(service, jobId);

    expect(cache.refund).not.toHaveBeenCalled();
    expect(db.refundOtpSent).not.toHaveBeenCalled();
    expect(cache.clear).not.toHaveBeenCalled();
  });

  /** But it still retires the challenge — a code nobody can receive should not sit
   *  there looking live. */
  it('still invalidates the challenge', async () => {
    const { service, db } = build('rejected');

    const jobId = await service.enqueue(JOB);
    await processJob(service, jobId);

    expect(db.invalidateChallenge).toHaveBeenCalledWith(JOB.challengeId);
  });
});

describe('a code that expired in the queue', () => {
  /**
   * ═══ THE LAST CHECK BEFORE THE WIRE ════════════════════════════════════════
   *
   * Checked immediately before SMTP, not at schedule time. A job on its fourth attempt
   * was queued 125 seconds ago and the relay it is waiting on may have been
   * unreachable far longer.
   *
   * Delivering a dead code is worse than delivering nothing: the admin receives mail,
   * types the code in, and is told it is invalid — which reads as our bug, and costs
   * them one of five guesses to find out.
   */
  it('is never handed to SMTP', async () => {
    const { service, mail } = build('sent');

    const jobId = await service.enqueue({ ...JOB, validUntil: new Date(Date.now() - 1000) });
    await processJob(service, jobId);

    expect(mail.sendLoginOtp).not.toHaveBeenCalled();
  });

  /** Treated as our outage rather than the address's fault — the code died waiting on
   *  a relay we could not reach — so the quotas come back. */
  it('is compensated like an outage', async () => {
    const { service, cache, db } = build('sent');

    const jobId = await service.enqueue({ ...JOB, validUntil: new Date(Date.now() - 1000) });
    await processJob(service, jobId);

    expect(cache.refund).toHaveBeenCalledWith(KEYS.rate.loginOtpShort(JOB.emailLower));
    expect(db.refundOtpSent).toHaveBeenCalledWith(JOB.attemptId);
    expect(db.invalidateChallenge).toHaveBeenCalledWith(JOB.challengeId);
  });
});

describe('recovery from a killed process', () => {
  /**
   * ═══ WHY THERE IS A `processing` LIST AT ALL ═══════════════════════════════
   *
   * This is the state people leave out, and leaving it out is what makes a durable
   * queue lossy. A worker moves a job to `processing` ATOMICALLY as it claims it
   * (`BRPOPLPUSH` is one command), so a process killed between the pop and the send
   * leaves the job visible rather than vanished.
   */
  it('returns in-flight jobs to the active list on shutdown', async () => {
    const { service, redis } = build();

    redis.lists.set(KEYS.otpQueue.processing(), ['job-a', 'job-b']);
    await service.onModuleDestroy();

    expect(redis.lists.get(KEYS.otpQueue.processing())).toEqual([]);
    expect(redis.lists.get(KEYS.otpQueue.active())?.sort()).toEqual(['job-a', 'job-b']);
  });

  /**
   * A recovered job may be one whose mail was ALREADY SENT — killed between the relay
   * accepting it and the bookkeeping. That means a duplicate code in the worst case,
   * and the duplicate is harmless in a way the alternative is not: `issue` supersedes
   * on write so only the newest code verifies, and an admin receiving the same code
   * twice is a confusion where losing it is a lockout.
   */
  it('prefers a possible duplicate over a possible loss', async () => {
    const { service, redis } = build();

    redis.lists.set(KEYS.otpQueue.processing(), ['maybe-already-sent']);
    await service.onModuleDestroy();

    expect(redis.lists.get(KEYS.otpQueue.active())).toEqual(['maybe-already-sent']);
  });

  /** Shutdown must not throw on an unreachable Redis — that turns a deploy into a
   *  hung container the orchestrator has to kill. */
  it('survives a Redis that will not answer during shutdown', async () => {
    const { service, redis } = build();
    redis.rpoplpush.mockRejectedValue(new Error('connection lost'));

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});

/**
 * ═══ THE PRODUCER'S CONNECTION IS NOT THE WORKERS' ═════════════════════════
 *
 * The measured fault these tests exist to prevent coming back:
 *
 *   `enqueue` wrote through the same ioredis connection the CONCURRENCY worker loops
 *   sit on with `BRPOPLPUSH(BLOCK_SECONDS)`. ioredis serialises commands per
 *   connection, so the producer's `SET` and `LPUSH` queued behind as many as five
 *   sequential two-second blocking reads. Measured: `enqueue` p50 8,344 ms, and a
 *   password step that issued a code took 6.1-10.4 SECONDS, of which ~8.6 s was that
 *   one call. The process was idle throughout - the socket simply was not free.
 *
 * The failure is invisible to every other test in this file, because a fake Redis has
 * no command queue. So these assert the STRUCTURE that makes it impossible: the
 * producer and the workers must be different connections, and nothing `enqueue` does
 * may touch the workers'.
 */
describe('producer / worker connection separation', () => {
  it('gives the producer its own connection, duplicated from the durable client', () => {
    const { service, redis } = build();

    expect(redis.duplicate).toHaveBeenCalledOnce();
    // Distinct objects: two sockets to one Redis.
    expect(redis.producer).not.toBe(redis);
    // Exactly one, for the life of the service - not one per enqueue.
    const producer = (service as unknown as { producer: unknown }).producer;
    expect(producer).toBe(redis.producer);
  });

  it('sends both of enqueue’s commands over the producer, and none over the workers’', async () => {
    const { service, redis } = build();

    await service.enqueue(JOB);

    expect(redis.producer.set).toHaveBeenCalledOnce();
    expect(redis.producer.lpush).toHaveBeenCalledOnce();
    // The connection the worker loops block on is untouched by a produce.
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.lpush).not.toHaveBeenCalled();
  });

  /**
   * The regression test proper. The worker connection is made to hang exactly the way
   * a parked `BRPOPLPUSH` makes it hang; `enqueue` must still finish. Route either of
   * its two commands back onto that connection and this never resolves.
   */
  it('completes while the worker connection is blocked indefinitely', async () => {
    const { service, redis } = build();

    const neverResolves = () => new Promise(() => {});
    redis.set.mockImplementation(neverResolves as never);
    redis.lpush.mockImplementation(neverResolves as never);
    redis.brpoplpush.mockImplementation(neverResolves as never);

    const jobId = await Promise.race([
      service.enqueue(JOB),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('enqueue blocked behind the worker connection')), 1000),
      ),
    ]);

    expect(typeof jobId).toBe('string');
    expect(redis.lists.get(KEYS.otpQueue.active())).toEqual([jobId]);
  });

  /** Many concurrent sign-ins share the one producer connection; none may be lost. */
  it('serves concurrent enqueues from the single shared producer connection', async () => {
    const { service, redis } = build();

    const ids = await Promise.all(Array.from({ length: 25 }, () => service.enqueue(JOB)));

    expect(new Set(ids).size).toBe(25);
    expect(redis.duplicate).toHaveBeenCalledOnce();
    expect(redis.producer.set).toHaveBeenCalledTimes(25);
    expect(redis.lists.get(KEYS.otpQueue.active())?.length).toBe(25);
  });

  /** A job produced on one connection is still consumed on the other. */
  it('leaves a queued job consumable by the worker path', async () => {
    const { service, redis, mail } = build();

    const jobId = await service.enqueue(JOB);
    await processJob(service, jobId);

    expect(mail.sendLoginOtp).toHaveBeenCalledOnce();
    expect(redis.strings.has(KEYS.otpQueue.job(jobId))).toBe(false);
  });

  /**
   * A reschedule runs INSIDE `process`, on a worker loop that is between two blocking
   * reads rather than inside one. It keeps the worker connection, and moving it to the
   * producer would be a change to worker behaviour rather than to this fix.
   */
  it('keeps the worker connection for a reschedule', async () => {
    const { service, redis } = build('unreachable');

    const jobId = await service.enqueue(JOB);
    redis.producer.set.mockClear();
    await processJob(service, jobId);

    expect(redis.set).toHaveBeenCalled();
    expect(redis.zadd).toHaveBeenCalledOnce();
    expect(redis.producer.set).not.toHaveBeenCalled();
  });

  /**
   * `enqueue` THROWS if the durable write fails and does not compensate - the quotas
   * are already spent and the challenge already issued, so failing the request lets the
   * admin retry into a clean state. Unchanged by the connection split.
   */
  it('still propagates a failed LPUSH after a successful SET', async () => {
    const { service, redis, cache, db } = build();

    redis.producer.lpush.mockRejectedValueOnce(new Error('durable redis is down'));

    await expect(service.enqueue(JOB)).rejects.toThrow('durable redis is down');
    // No compensation from inside enqueue, exactly as before: the payload stays under
    // its TTL and no quota is refunded here.
    expect(cache.refund).not.toHaveBeenCalled();
    expect(db.invalidateChallenge).not.toHaveBeenCalled();
    expect(redis.producer.set).toHaveBeenCalledOnce();
  });

  it('opens the producer connection at bootstrap rather than on the first sign-in', () => {
    const { service, redis } = build();

    service.onApplicationBootstrap();

    expect(redis.producer.connect).toHaveBeenCalledOnce();
    void service.onModuleDestroy();
  });

  it('closes the producer connection on shutdown', async () => {
    const { service, redis } = build();

    await service.onModuleDestroy();

    expect(redis.producer.quit).toHaveBeenCalledOnce();
  });
});
