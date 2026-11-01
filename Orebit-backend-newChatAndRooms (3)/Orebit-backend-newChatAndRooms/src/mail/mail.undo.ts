import { Injectable, Logger } from '@nestjs/common';
import { CacheService, KEYS, QuotaService } from '../../redis';
import { UNDO_IS_IDEMPOTENT, type MailUndo, type MailUndoKind } from './mail.types';

/** How long a once-only compensation claim is remembered. Only has to outlive the
 *  record's retries, which `RECLAIM_AFTER_MS` measures in minutes. */
const UNDO_CLAIM_TTL = 24 * 60 * 60;

/** Runs one kind of compensation. Registered by whichever module owns the state. */
export type MailUndoHandler = (undo: MailUndo) => Promise<void>;

/**
 * ═══ WHO RUNS AN UNDO, AND WHY IT IS NOT THIS MODULE ════════════════════════
 *
 * A `MailUndo` says WHAT to compensate. Something has to know HOW, and for one of
 * the three kinds that knowledge lives in `auth`:
 * `registration.refund-otp-send` is an UPDATE on the registrations table.
 *
 * `MailModule` is `@Global()` and imported everywhere, so it cannot depend on `auth`
 * — that is a cycle, and the kind Nest can only resolve with `forwardRef`. Nor should
 * it: a mail queue that knows about registration rows is a mail queue that will
 * eventually know about everything.
 *
 * So the dependency is inverted. This registry holds a map from kind to handler; the
 * mail module registers the two `cache.*` kinds it can service itself (`CacheService`
 * comes from `redis/`, which is also global), and `auth` registers the one it owns at
 * boot. The worker asks the registry and never learns what a registration is.
 *
 * ─── Why an unhandled kind is loud rather than fatal ────────────────────────
 *
 * A missing handler means a user was charged for mail that never arrived and nothing
 * gave it back. That is worth an error log naming the user-visible consequence. It is
 * NOT worth throwing: the throw would happen inside the worker's failure path, where
 * it can only turn one lost refund into a stalled queue.
 */
@Injectable()
export class MailUndoRegistry {
  private readonly logger = new Logger('MailUndo');
  private readonly handlers = new Map<MailUndoKind, MailUndoHandler>();

  constructor(
    private readonly cache: CacheService,
    private readonly quota: QuotaService,
  ) {
    // The three this module can service without reaching outside `redis/`.
    //
    // Every one uses the `OrThrow` variant. The ordinary `CacheService.refund`/`clear`
    // and `QuotaService.refund` catch their own errors and log — correct for their
    // other callers, who have nowhere to retry to, and exactly wrong here: a
    // Redis-down compensation returned normally, `runAll` logged 'undelivered mail
    // compensated', and nothing had been given back. A false success is worse than a
    // failure, because only the failure gets retried.
    this.register('cache.clear', async (undo) => {
      if (undo.kind !== 'cache.clear') return;
      await this.cache.clearOrThrow(undo.key);
    });

    this.register('cache.refund', async (undo) => {
      if (undo.kind !== 'cache.refund') return;
      await this.cache.refundOrThrow(undo.key);
    });

    this.register('quota.refund', async (undo) => {
      if (undo.kind !== 'quota.refund') return;
      await this.quota.refundOrThrow({ token: undo.token, keys: undo.keys }, undo.store);
    });
  }

  /**
   * Claim a kind.
   *
   * Refuses to overwrite, because two handlers for one kind means the one that wins
   * depends on module initialisation order — and a compensation running the wrong way
   * round is worse than one not running at all.
   */
  register(kind: MailUndoKind, handler: MailUndoHandler): void {
    if (this.handlers.has(kind)) {
      throw new Error(`a MailUndo handler for "${kind}" is already registered`);
    }
    this.handlers.set(kind, handler);
  }

  /**
   * Run every compensation for a message that will not be delivered.
   *
   * Each one is attempted independently: the login path parks TWO undos (a cooldown
   * to clear and a budget slot to refund), and one failing must not cost the user the
   * other. Never throws, for the reason in the class comment.
   *
   * ─── Returns whether everything settled, and why that is new ────────────────
   *
   * It used to return `void` and swallow both failure paths with a log. That was the
   * only option available to it — there was nowhere to retry to, because the message
   * had already been dead-lettered and acked before this ran. Now the compensation is
   * a durable record on its own stream, so the caller CAN retry, and the one thing it
   * needs from here is the truth about whether it should.
   *
   * `false` therefore means "do not ack this record". A missing handler counts as
   * unsettled too: a deployment where `auth` has not registered its kind yet is a
   * temporary condition, and the record should wait rather than be discarded.
   */
  async runAll(
    undos: readonly MailUndo[],
    context: { jobId: string; kind: string },
  ): Promise<boolean> {
    let allSettled = true;

    for (const [index, undo] of undos.entries()) {
      const handler = this.handlers.get(undo.kind);

      if (handler === undefined) {
        this.logger.error(
          { ...context, undo: undo.kind },
          'NO HANDLER for this compensation — a user has been charged for mail that ' +
            'never arrived and nothing gave it back',
        );
        allSettled = false;
        continue;
      }

      // Non-idempotent handlers get a once-only claim, taken BEFORE the work. If this
      // record is redelivered — because a sibling undo in it failed, or a worker died
      // holding it — the claim is already gone and this one is skipped. The bias is
      // deliberate: a crash between claiming and running loses one refund, whereas the
      // other bias hands back two slots for one failed send.
      if (!UNDO_IS_IDEMPOTENT[undo.kind] && !(await this.claim(context.jobId, index))) {
        this.logger.warn(
          { ...context, undo: undo.kind, index },
          'compensation already claimed by an earlier delivery; not repeating it',
        );
        continue;
      }

      try {
        await handler(undo);
        this.logger.warn({ ...context, undo: undo.kind }, 'undelivered mail compensated');
      } catch (err) {
        // Reported rather than swallowed. The caller leaves the record unacked, so
        // `XAUTOCLAIM` brings it back and this runs again.
        this.logger.error(
          { ...context, undo: undo.kind, err },
          'undelivered mail — COMPENSATION FAILED; it will be retried',
        );
        allSettled = false;
      }
    }

    return allSettled;
  }

  /**
   * Take the once-only claim for one compensation, or report that someone already has.
   *
   * `setIfAbsent` is a `SET NX`, so exactly one caller can win. On a Redis failure it
   * returns false and the compensation is skipped — the same at-most-once bias as
   * above, and the alternative would be to treat an unreachable Redis as permission to
   * run a non-idempotent refund again.
   *
   * The TTL only has to outlive the record's retries; `RECLAIM_AFTER_MS` is two
   * minutes, so a day is generous by three orders of magnitude and still bounds the
   * key.
   */
  private async claim(jobId: string, index: number): Promise<boolean> {
    try {
      return await this.cache.setIfAbsent(KEYS.mail.undoClaim(jobId, index), '1', UNDO_CLAIM_TTL);
    } catch (err) {
      this.logger.error({ err, jobId, index }, 'could not take a compensation claim');
      return false;
    }
  }
}
