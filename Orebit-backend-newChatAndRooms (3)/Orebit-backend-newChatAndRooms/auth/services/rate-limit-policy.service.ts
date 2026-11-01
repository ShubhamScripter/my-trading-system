import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { KEYS, RedisService, RedisSubscriberService } from '../../redis';
import { commitPolicy, policy as currentPolicy, validatePolicy } from '../limits';
import { RateLimitPolicyDbOperation } from '../persistence/rate-limit-policy.dboperation';

/**
 * How often the safety poll runs when nothing has published.
 *
 * This was five seconds, which is 17,280 queries a day per instance — 172,800 across
 * ten — to notice a change that happens a few times a year. Polling was doing the
 * whole job because there was no invalidation channel; now that there is, it is a
 * backstop for a message published while an instance was reconnecting, and a backstop
 * can be slow. Five minutes is 288 a day per instance.
 */
const POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Loads the audited policy snapshot before this instance accepts traffic, and keeps
 * every instance converged on it afterwards.
 *
 * The eventual protected admin API calls `activate`; every other instance finds out
 * through the invalidation channel, with the poll underneath. Keeping the write
 * surface out of user auth prevents a user credential from ever changing a limit.
 */
@Injectable()
export class RateLimitPolicyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RateLimitPolicy');
  private readonly channel = KEYS.channel.rateLimitPolicy();
  private version = 0;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly policies: RateLimitPolicyDbOperation,
    private readonly redis: RedisService,
    private readonly subscriber: RedisSubscriberService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    await this.watchForChanges();

    // The backstop, not the mechanism. `unref` ensures this operational timer never
    // prevents a process or test runner from shutting down.
    this.refreshTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Subscribe to the invalidation channel, and re-read whenever the connection comes
   * back.
   *
   * The `ready` handler is not redundant with the subscription. Redis pub/sub has no
   * backlog: a message published while this socket was down is gone, and ioredis
   * re-issuing the SUBSCRIBE on reconnect does not replay it. Re-reading on `ready`
   * closes exactly that window, and costs one query per reconnect.
   *
   * A failure to subscribe is logged, not thrown. The poll still converges this
   * instance — more slowly — and refusing to boot over a degraded invalidation path
   * would turn a cache problem into an outage.
   */
  private async watchForChanges(): Promise<void> {
    try {
      this.subscriber.on('message', (channel: string) => {
        if (channel !== this.channel) return;
        void this.refresh();
      });
      this.subscriber.on('ready', () => void this.refresh());
      await this.subscriber.subscribe(this.channel);
      this.logger.log({ channel: this.channel }, 'watching for rate-limit policy changes');
    } catch (error) {
      this.logger.error(
        { error, channel: this.channel },
        'could not subscribe to rate-limit policy invalidation; falling back to the poll',
      );
    }
  }

  /**
   * Adopt the stored policy, if it is newer than what this instance is running.
   *
   * Validation happens here and not only in `activate` because this is the path that
   * reads a value written by ANOTHER process: an older build's schema, a hand-edited
   * row, a bad migration. A rejected snapshot leaves the previous policy running,
   * which is the safe direction — the alternative was adopting `{}` and discovering it
   * at a request-path call site.
   */
  async refresh(): Promise<void> {
    try {
      const stored = await this.policies.active();
      if (stored === null || stored.version === this.version) return;

      const result = validatePolicy(stored.policy);
      if (!result.ok) {
        this.logger.error(
          { version: stored.version, problems: result.problems },
          'stored rate-limit policy rejected; retaining the current snapshot',
        );
        return;
      }

      commitPolicy(result.policy);
      this.version = stored.version;
      this.logger.log({ version: this.version }, 'rate-limit policy loaded');
    } catch (error) {
      // Safe defaults remain active: configuration loss must never become unlimited
      // authentication traffic or prevent every user from signing in.
      this.logger.error({ error }, 'rate-limit policy unavailable; retaining current snapshot');
    }
  }

  /**
   * Internal admin integration point.
   *
   * ─── The ordering, which is the whole point of this method ──────────────────
   *
   * Validate, PERSIST, then swap, then tell everyone else.
   *
   * It used to validate-and-swap first and persist second, and the comment claimed the
   * opposite. When the transaction failed, this instance was left enforcing limits
   * that no other instance had, that no audit row recorded, and that nobody could look
   * up afterwards to find out what they had been — a divergence that resolved itself
   * only on the next poll, silently, with no indication it had happened.
   *
   * With persistence first, a failure at any step leaves every instance on the policy
   * they were already agreeing on. The swap cannot fail, so nothing can go live
   * without being durable and audited first.
   */
  async activate(actor: string, next: unknown): Promise<number> {
    const previous = currentPolicy();

    const result = validatePolicy(next);
    if (!result.ok) throw new Error(`invalid rate-limit policy: ${result.problems.join('; ')}`);

    // Throws on failure, and nothing has changed yet when it does.
    const version = await this.policies.activate(actor, result.policy);

    commitPolicy(result.policy);
    this.version = version;
    this.logger.warn({ actor, version, previous }, 'rate-limit policy activated');

    await this.publishChange(version);
    return version;
  }

  /**
   * Tell every other instance to re-read.
   *
   * After the swap, and its failure is not the caller's problem: the policy is already
   * durable and this instance is already on it, so a publish that does not land costs
   * the other instances a slower convergence rather than a wrong one. Throwing here
   * would report a failed activation that in fact succeeded.
   */
  private async publishChange(version: number): Promise<void> {
    try {
      await this.redis.publish(this.channel, String(version));
    } catch (error) {
      this.logger.error(
        { error, version },
        'rate-limit policy activated but the invalidation could not be published; ' +
          'other instances will converge on the next poll',
      );
    }
  }
}
