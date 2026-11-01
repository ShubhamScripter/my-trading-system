import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { CacheService, DurableRedisService, KEYS } from '../../redis';
import { config } from '../config';
import { uuidv7 } from '../utils/public.utils';
import { MailService } from './mail.service';
import { OtpQueueDbOperation } from './otp-queue.dboperation';

/**
 * ═══ THE DURABLE OTP QUEUE ═════════════════════════════════════════════════════
 *
 * Outbound sign-in codes, moved off the request path and onto storage that survives a
 * restart.
 *
 * ─── What was wrong with sending inline ────────────────────────────────────────
 *
 * `MailService`'s docblock recorded this as known debt, and the shape of the problem
 * is worth keeping written down because it is the whole justification for the file.
 *
 * The send was inside the HTTP request, with a 15-second connection timeout and a
 * 20-second socket timeout. So: a slow relay held an admin's sign-in open for up to
 * 35 seconds; a relay that was briefly unreachable lost the message outright, because
 * nothing anywhere held a second copy; and a deploy landing mid-send lost it too,
 * bounded only by a best-effort 5-second drain. Every one of those is a *total*
 * lockout rather than an inconvenience, because the emailed code is a mandatory second
 * factor and the password-recovery flow was removed.
 *
 * ─── Reliable, not merely durable ──────────────────────────────────────────────
 *
 * Four Redis keys, because a queue that can lose a job to a killed process needs four
 * states rather than two. The one people leave out is `processing`: a worker moves a
 * job there ATOMICALLY as it claims it (`BRPOPLPUSH` is one command), so a process
 * killed between the pop and the send leaves the job visible rather than vanished.
 * `onModuleDestroy` returns those jobs, and anything a hard kill strands is recovered
 * by the next boot's sweep.
 *
 * ─── What the queue does NOT do ────────────────────────────────────────────────
 *
 * It does not decide whether a code may be sent. Every quota, cooldown and budget is
 * charged by `LoginService` BEFORE a job is enqueued — the queue's only accounting act
 * is to give those charges back when delivery finally fails. A queue that could refuse
 * would be a second policy engine, disagreeing with the first.
 */

/** Delivery attempts, and the wait before each. */
const SCHEDULE_SECONDS = [0, 5, 30, 90] as const;

/**
 * How many workers pull from the queue at once.
 *
 * Matched to `MailService`'s pool (`POOL.MAX_CONNECTIONS`, five). More workers than
 * sockets would just queue inside nodemailer, where there is no visibility and no
 * timeout of our own; fewer would leave sockets idle. Relays throttle on concurrent
 * connections, so five is the relay's ceiling rather than ours.
 */
const CONCURRENCY = 5;

/**
 * How long a worker blocks on an empty queue before looping.
 *
 * Two seconds is the shutdown latency: `onModuleDestroy` sets the stop flag, and a
 * worker parked in `BRPOPLPUSH` notices only when its block expires. Long enough that
 * an idle service is not spinning, short enough that a deploy is not waiting on it.
 */
const BLOCK_SECONDS = 2;

/**
 * How long a worker waits after an error before trying again.
 *
 * The loop's only other throttle is `brpoplpush` blocking, and that is precisely what
 * stops throttling when Redis is unreachable — the call rejects at once. Matched to
 * `BLOCK_SECONDS` so a failing loop polls no faster than an idle one does.
 */
const ERROR_BACKOFF_MS = BLOCK_SECONDS * 1000;

/** AES-256-GCM. 12-byte IV is the standard for GCM; 16-byte tag is its full width. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The decrypted contents of one job.
 *
 * `code` is the only live credential this service ever writes to storage outside a
 * peppered digest, which is what the envelope around it exists for.
 */
interface OtpJob {
  readonly adminId: string;
  readonly challengeId: string;
  readonly attemptId: string;
  /** Keys the two rolling quotas and the cooldown, for the compensation path. */
  readonly emailLower: string;
  readonly to: string;
  readonly code: string;
  readonly minutesValid: number;
  /**
   * When the code stops being worth sending — the challenge's own expiry.
   *
   * Checked immediately before SMTP rather than only at schedule time, because a job
   * on its fourth attempt was queued 125 seconds ago and the relay may have been
   * unreachable for far longer than that. Delivering a code that is already dead is
   * worse than not delivering it: the admin gets mail, types it in, and is told it is
   * invalid.
   */
  readonly validUntil: number;
  /** 0-based index into SCHEDULE_SECONDS. */
  readonly attempt: number;
}

export interface EnqueueOtpInput {
  readonly adminId: string;
  readonly challengeId: string;
  readonly attemptId: string;
  readonly emailLower: string;
  readonly to: string;
  readonly code: string;
  readonly minutesValid: number;
  readonly validUntil: Date;
}

@Injectable()
export class OtpQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OtpQueue');
  private running = false;
  private workers: Promise<void>[] = [];

  /**
   * ═══ THE PRODUCER'S OWN CONNECTION ═════════════════════════════════════════
   *
   * `enqueue` writes through this; the worker loops below keep the injected
   * `DurableRedisService`. They are two sockets to the SAME instance, and the split
   * is the whole of this fix.
   *
   * ─── Why one connection was not enough ─────────────────────────────────────
   *
   * ioredis serialises commands on a connection: they go out in order and each waits
   * for the one before it to answer. `BRPOPLPUSH` with a timeout is a command that
   * deliberately does not answer for up to `BLOCK_SECONDS`, and there are
   * `CONCURRENCY` loops issuing it. So a `SET` and an `LPUSH` from a request landed
   * behind as many as five sequential two-second blocking reads.
   *
   * Measured on this service before the split: `enqueue` p50 8,344 ms, and a password
   * step that issued a code took 6.1-10.4 SECONDS end to end, of which ~8.6 s was this
   * one call. On a dedicated connection the same two commands are p50 2 ms. The
   * process was idle throughout — event-loop utilisation 0.44 % — because nothing was
   * computing; the socket was simply not free.
   *
   * durable.client.ts already records this hazard as the reason the durable client is
   * separate from the CACHE client. What it did not cover is that the queue's own
   * producer and its own workers are also two different kinds of caller on one socket.
   *
   * ─── `duplicate()` rather than a second provider ───────────────────────────
   *
   * It copies the options object, so the producer inherits `maxRetriesPerRequest: 10`,
   * the bounded backoff and `lazyConnect` from `DurableRedisService` and cannot drift
   * from it. A hand-built second client would be a second place to keep those in step,
   * which is the same argument MailService makes for spreading its primary transport's
   * options into the backup.
   *
   * ONE connection for the whole process, not one per call: it is created here, in the
   * constructor, and reused by every concurrent `enqueue`. ioredis is safe to share
   * across concurrent callers — that is exactly what it is for — and the commands that
   * travel over it now are non-blocking, so they cannot queue behind each other for
   * any meaningful time.
   */
  private readonly producer: Redis;

  constructor(
    private readonly redis: DurableRedisService,
    private readonly mail: MailService,
    private readonly cache: CacheService,
    private readonly db: OtpQueueDbOperation,
  ) {
    // Assigned in the constructor BODY rather than as a field initialiser, because a
    // field initialiser cannot depend on a parameter property.
    this.producer = this.redis.duplicate();
  }

  // ─── producer ─────────────────────────────────────────────────────────────

  /**
   * Accept a code for delivery. Returns once it is durably stored, not once it is
   * sent.
   *
   * Throws if the write fails, and that is deliberate — it is the one place in this
   * file that does. `LoginService` has already charged the quotas and issued the
   * challenge by this point, so a silent failure here would leave an admin with a
   * spent budget, a live challenge row and no code coming. Better to fail the request
   * and let them retry into a clean state.
   */
  async enqueue(input: EnqueueOtpInput): Promise<string> {
    const jobId = uuidv7();
    const job: OtpJob = {
      adminId: input.adminId,
      challengeId: input.challengeId,
      attemptId: input.attemptId,
      emailLower: input.emailLower,
      to: input.to,
      code: input.code,
      minutesValid: input.minutesValid,
      validUntil: input.validUntil.getTime(),
      attempt: 0,
    };

    // Both commands go over `producer`, never the connection the worker loops block
    // on. Same keys, same order, same payload as before - only the socket differs.
    await this.store(jobId, job, this.producer);
    // Straight onto `active`, not `delayed` with a score of now: the first attempt has
    // a delay of zero, and routing it through the sorted set would make the first send
    // wait for a promotion sweep it does not need.
    await this.producer.lpush(KEYS.otpQueue.active(), jobId);

    this.logger.debug({ jobId, adminId: input.adminId }, 'sign-in code queued');
    return jobId;
  }

  // ─── worker ───────────────────────────────────────────────────────────────

  /**
   * `onApplicationBootstrap`, not `onModuleInit`.
   *
   * Workers must not start pulling jobs until every module they depend on is fully
   * initialised — `MailService.onModuleInit` verifies its SMTP credentials, and a
   * worker that started first could try to send through a transport still being set
   * up.
   */
  onApplicationBootstrap(): void {
    this.running = true;

    // Open the producer socket now rather than on the first sign-in. `duplicate()`
    // inherits `lazyConnect`, so without this the first `enqueue` of the process would
    // pay TCP + AUTH inside a request. Deliberately not awaited, so this hook keeps its
    // synchronous signature and boot is not gated on a second socket: ioredis queues
    // commands issued while connecting, so an `enqueue` that arrives first is sent as
    // soon as the connection is up rather than being lost.
    this.producer.connect().catch((err: unknown) => {
      this.logger.error({ err }, 'producer connection could not be opened at boot');
    });

    // Anything a previous process was mid-send on when it was killed. Runs once, at
    // boot, before the workers start competing for the same list.
    void this.recoverStranded();
    for (let i = 0; i < CONCURRENCY; i += 1) this.workers.push(this.loop(i));
    this.logger.log({ concurrency: CONCURRENCY }, 'OTP queue workers started');
  }

  /**
   * Stop accepting, let in-flight sends finish, and put back what was not finished.
   *
   * The order is load-bearing. Clearing `running` first means no worker claims a NEW
   * job while we are draining; awaiting the loops means a send already on the wire
   * gets to complete rather than being abandoned mid-SMTP; and returning `processing`
   * last means anything that did not complete is queued again for the next process
   * rather than being stranded until the boot sweep notices.
   */
  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.workers);
    await this.recoverStranded();

    // Last, because `recoverStranded` above runs on the WORKER connection and must
    // finish first. `quit` rather than `disconnect`: this connection never holds a
    // blocking command, so there is nothing for a graceful close to hang behind - the
    // reason durable.client.ts gives for preferring `disconnect` does not apply here.
    // Swallowed, because a connection that is already gone is not a shutdown failure.
    await this.producer.quit().catch(() => undefined);
  }

  /**
   * Move everything in `processing` back to `active`.
   *
   * `RPOPLPUSH` in a loop rather than reading the list and rewriting it: the loop is
   * atomic per element, so running this at boot while another process is still
   * shutting down cannot duplicate a job or drop one.
   *
   * A recovered job may be one whose mail was ALREADY SENT — killed between the relay
   * accepting it and the `LREM`. That means a duplicate code in the worst case, and
   * the duplicate is harmless in a way the alternative is not: `ChallengeDbOperation`
   * supersedes on issue so only the newest code verifies, and an admin receiving the
   * same code twice is a confusion, where losing it is a lockout.
   */
  private async recoverStranded(): Promise<void> {
    try {
      let recovered = 0;
      // Bounded so a pathological queue cannot spin here forever at boot.
      while (recovered < 1000) {
        const moved = await this.redis.rpoplpush(
          KEYS.otpQueue.processing(),
          KEYS.otpQueue.active(),
        );
        if (moved === null) break;
        recovered += 1;
      }
      if (recovered > 0) {
        this.logger.warn({ recovered }, 'returned stranded OTP jobs to the queue');
      }
    } catch (err) {
      this.logger.error({ err }, 'could not recover stranded OTP jobs');
    }
  }

  private async loop(worker: number): Promise<void> {
    while (this.running) {
      try {
        await this.promoteDue();

        const jobId = await this.redis.brpoplpush(
          KEYS.otpQueue.active(),
          KEYS.otpQueue.processing(),
          BLOCK_SECONDS,
        );
        if (jobId === null) continue;

        await this.process(jobId);
        // Only after `process` has fully resolved the job — sent, rescheduled, or
        // failed terminally. Removing it earlier would drop a job whose reschedule
        // then failed to write.
        await this.redis.lrem(KEYS.otpQueue.processing(), 1, jobId);
      } catch (err) {
        // A worker loop must never exit on an error, or the queue quietly loses a
        // fifth of its capacity per incident until nothing is delivered at all.
        this.logger.error({ err, worker }, 'OTP worker iteration failed; continuing');

        // ─── And it must not spin ──────────────────────────────────────────
        //
        // Without this pause the loop is only throttled by `brpoplpush` BLOCKING,
        // which is exactly what stops happening when Redis is unreachable: the call
        // rejects immediately, the catch logs, and the loop comes straight back
        // round. Five workers then produce a tight error loop that burns a core and
        // writes thousands of identical lines a second — turning a recoverable Redis
        // blip into a log flood that hides the incident that caused it.
        await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
      }
    }
  }

  /**
   * Move every job whose backoff has elapsed from `delayed` to `active`.
   *
   * One Lua script, so the read, the removal and the push are one atomic step. Split
   * into separate commands, two workers running this concurrently both see the same
   * due member, both push it, and the code is sent twice.
   */
  private async promoteDue(): Promise<void> {
    await this.redis.eval(
      `local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 50)
       for i = 1, #due do
         if redis.call('ZREM', KEYS[1], due[i]) == 1 then
           redis.call('LPUSH', KEYS[2], due[i])
         end
       end
       return #due`,
      2,
      KEYS.otpQueue.delayed(),
      KEYS.otpQueue.active(),
      String(Date.now()),
    );
  }

  private async process(jobId: string): Promise<void> {
    const job = await this.load(jobId);
    if (job === null) {
      // Unreadable, forged, or expired out from under us. Nothing to compensate —
      // without the payload there is no challenge id to invalidate or quota to refund.
      this.logger.error({ jobId }, 'OTP job could not be read; dropping');
      return;
    }

    // ═══ THE LAST CHECK BEFORE THE WIRE ══════════════════════════════════════
    //
    // Not at schedule time, HERE. A job on its fourth attempt was queued 125 seconds
    // ago, and the relay it is waiting on may have been unreachable far longer.
    // Delivering a dead code is worse than delivering nothing: the admin gets mail,
    // types the code in, and is told it is invalid — which reads as our bug, and
    // costs them one of five guesses finding out.
    if (job.validUntil <= Date.now()) {
      this.logger.warn(
        { jobId, adminId: job.adminId },
        'sign-in code expired before it could be delivered; compensating',
      );
      await this.compensate(jobId, job, 'expired');
      return;
    }

    const outcome = await this.mail.sendLoginOtp(job.to, job.code, job.minutesValid);

    if (outcome === 'sent') {
      await this.discard(jobId);
      this.logger.log(
        { jobId, adminId: job.adminId, attempt: job.attempt + 1 },
        'sign-in code delivered',
      );
      return;
    }

    // ═══ REJECTED IS TERMINAL ON THE FIRST ATTEMPT ═══════════════════════════
    //
    // A relay that answered and refused this recipient will refuse it again — the
    // address is the problem, not the relay. Retrying spends our sending reputation
    // three more times to deliver nothing. `MailService` has already declined to try
    // the backup relay for the same reason.
    if (outcome === 'rejected') {
      this.logger.error(
        { jobId, adminId: job.adminId },
        'sign-in code rejected for this recipient; not retrying',
      );
      await this.compensate(jobId, job, 'rejected');
      return;
    }

    // `'unreachable'` — ours to own, and the case the schedule exists for.
    const next = job.attempt + 1;
    if (next >= SCHEDULE_SECONDS.length) {
      this.logger.error(
        { jobId, adminId: job.adminId, attempts: SCHEDULE_SECONDS.length },
        'sign-in code undeliverable after every attempt; compensating',
      );
      await this.compensate(jobId, job, 'unreachable');
      return;
    }

    const delaySeconds = SCHEDULE_SECONDS[next] as number;
    // The WORKER connection here, deliberately. This runs inside `process`, which is
    // already on a worker loop, and that loop is not blocked while it is running -
    // it is between two `BRPOPLPUSH` calls, not inside one.
    await this.store(jobId, { ...job, attempt: next }, this.redis);
    await this.redis.zadd(
      KEYS.otpQueue.delayed(),
      Date.now() + delaySeconds * 1000,
      jobId,
    );
    this.logger.warn(
      { jobId, adminId: job.adminId, attempt: next, delaySeconds },
      'sign-in code send failed; rescheduled',
    );
  }

  /**
   * ═══ GIVE BACK WHAT THE SEND WAS CHARGED ═══════════════════════════════════
   *
   * Delivery has failed for good. Everything `LoginService` charged optimistically at
   * enqueue is returned, and the challenge is retired so the admin's next request is
   * told to ask for a new code rather than waiting for one that will never arrive.
   *
   * ─── `rejected` is NOT refunded, and the asymmetry is the point ─────────────
   *
   * A refused recipient is not our outage. Refunding it would hand an admin whose
   * address is permanently undeliverable an unlimited supply of free sends against a
   * mailbox that can never receive — which is the one direction these quotas exist to
   * bound. The challenge is still invalidated, because a code nobody can receive
   * should not sit there looking live.
   *
   * `expired` IS refunded. The code died waiting on a relay we could not reach, which
   * is the same outage as `unreachable` wearing a different hat.
   */
  private async compensate(
    jobId: string,
    job: OtpJob,
    reason: 'rejected' | 'unreachable' | 'expired',
  ): Promise<void> {
    await this.discard(jobId);

    // Always. A live challenge for a code that was never delivered is a trap: the
    // client polls `state`, sees a live OTP window, and waits out ten minutes.
    await this.db.invalidateChallenge(job.challengeId);

    if (reason === 'rejected') return;

    // The per-attempt counter, the two rolling quotas, and the cooldown — every charge
    // the enqueue path made, in the order it made them. `CacheService.refund`
    // deliberately declines to resurrect an expired key, so a refund landing after its
    // window closed is a no-op rather than a negative counter.
    await this.db.refundOtpSent(job.attemptId);
    await this.cache.refund(KEYS.rate.loginOtpShort(job.emailLower));
    await this.cache.refund(KEYS.rate.loginOtpDaily(job.emailLower));
    // Cleared rather than refunded: it is a cooldown, not a counter, and leaving it
    // running would make the admin wait 60 seconds before they could ask for the
    // replacement code this failure just made necessary.
    await this.cache.clear(KEYS.rate.loginOtpCooldown(job.emailLower));
  }

  // ─── the envelope ─────────────────────────────────────────────────────────

  /**
   * Seal a job under AES-256-GCM, bound to its own identity.
   *
   * ═══ WHY THE AAD IS NOT DECORATION ═══════════════════════════════════════════
   *
   * `jobId:adminId:challengeId` goes in as additional authenticated data — covered by
   * the tag, not encrypted. Without it, a ciphertext is a free-floating blob: anyone
   * who can write to Redis could copy the envelope stored under one job id to another
   * job id, and the worker would decrypt it happily and deliver admin A's code to
   * whatever recipient the job it replaced named. With it, the tag is computed over
   * the identity as well as the contents, so a payload moved to a different key fails
   * authentication instead of being honoured.
   *
   * ─── Why the ids are also stored in the CLEAR ──────────────────────────────
   *
   * Because otherwise the scheme is circular. GCM requires `setAAD` before the first
   * `update`, but two of the three AAD components live inside the payload that has not
   * been decrypted yet — so a reader cannot construct the AAD it needs in order to
   * decrypt. Attempting it anyway (decrypt without AAD, read the ids, verify a second
   * time) does not work: the first `final()` fails the tag check, because the
   * ciphertext was sealed WITH an AAD.
   *
   * So the stored value is `adminId:challengeId:<base64 envelope>` and the header is
   * what the AAD is rebuilt from. That header is plaintext but not unauthenticated:
   * it is exactly what the tag covers, so editing it makes the tag fail. It discloses
   * two opaque UUIDs to anyone who can already read this Redis instance — and the
   * thing worth protecting there is the CODE, which stays sealed.
   *
   * Envelope layout is `iv | tag | ciphertext`. One value rather than three keys
   * because the whole thing is written and read as a unit; the TOTP factor splits them
   * across columns for a different reason (a key rotation there wants a plain
   * per-column UPDATE).
   */
  private async store(jobId: string, job: OtpJob, client: Redis): Promise<void> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', config.otpQueueKey, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(this.aad(jobId, job.adminId, job.challengeId), 'utf8'));

    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(job), 'utf8'),
      cipher.final(),
    ]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    const envelope = `${job.adminId}:${job.challengeId}:${sealed}`;

    // A TTL, so a job that is somehow never processed cannot hold a live code in
    // storage forever. Sized to outlive the whole retry schedule with room to spare,
    // and floored so a code that is already near expiry still gets its attempts.
    const ttlSeconds = Math.max(
      60,
      Math.ceil((job.validUntil - Date.now()) / 1000) + SCHEDULE_SECONDS.length * 120,
    );
    await client.set(KEYS.otpQueue.job(jobId), envelope, 'EX', ttlSeconds);
  }

  /**
   * Open an envelope, or null if it cannot be authenticated.
   *
   * Every failure — missing key, truncated blob, wrong tag, a payload moved from
   * another job — lands on the same null. There is no caller who could act on the
   * difference, and distinguishing them would only invite someone to log the reason
   * next to the ciphertext.
   */
  private async load(jobId: string): Promise<OtpJob | null> {
    try {
      const raw = await this.redis.get(KEYS.otpQueue.job(jobId));
      if (raw === null) return null;

      // `adminId:challengeId:<base64>`. Split on the first two separators only — the
      // ids are UUIDs and contain none, and base64 contains none either, but slicing
      // rather than a bare `split` keeps that from being load-bearing.
      const first = raw.indexOf(':');
      const second = raw.indexOf(':', first + 1);
      if (first <= 0 || second <= first + 1) return null;

      const adminId = raw.slice(0, first);
      const challengeId = raw.slice(first + 1, second);
      const buf = Buffer.from(raw.slice(second + 1), 'base64');
      if (buf.length <= IV_BYTES + TAG_BYTES) return null;

      const iv = buf.subarray(0, IV_BYTES);
      const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);

      const decipher = createDecipheriv('aes-256-gcm', config.otpQueueKey, iv, {
        authTagLength: TAG_BYTES,
      });
      // The AAD is rebuilt from the KEY this envelope was found under plus the header
      // ids — so an envelope copied to a different job id, or one whose header was
      // edited, produces a different AAD and `final()` throws. That is the binding.
      decipher.setAAD(Buffer.from(this.aad(jobId, adminId, challengeId), 'utf8'));
      decipher.setAuthTag(tag);

      // `final()` is what authenticates. Nothing below it is trusted until it returns.
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const job = JSON.parse(plaintext.toString('utf8')) as OtpJob;

      // The header claimed these ids and the tag proved the claim, but the tag says
      // nothing about the payload AGREEING with the header — a job sealed with a
      // matching AAD could still carry different ids inside. Cheap to check, and it is
      // the ids from inside the envelope that the compensation path spends.
      if (job.adminId !== adminId || job.challengeId !== challengeId) return null;

      return job;
    } catch {
      return null;
    }
  }

  private aad(jobId: string, adminId: string, challengeId: string): string {
    return `${jobId}:${adminId}:${challengeId}`;
  }

  /** Drop the envelope. The code inside is spent or dead either way, and leaving it
   *  in storage is only something to leak. */
  private async discard(jobId: string): Promise<void> {
    try {
      await this.redis.del(KEYS.otpQueue.job(jobId));
    } catch (err) {
      this.logger.error({ err, jobId }, 'could not delete a spent OTP job payload');
    }
  }
}
