import { Injectable, Logger } from '@nestjs/common';
import type { BlockedEmailKind } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { CacheService, KEYS } from '../../redis';
import { BLOCKLIST } from '../auth.constants';
import { BlocklistDbOperation } from '../persistence/blocklist.dboperation';
import { blocklistCandidates } from '../security/blocklist';

/** What a lookup found. Only the two fields a decision or a log line needs. */
interface BlocklistMatch {
  readonly value: string;
  readonly kind: BlockedEmailKind;
}

/**
 * "May this address use the product?" — asked at every door.
 *
 * One service rather than the check being inlined at each call site, because the
 * doors are not obviously the same shape: signup has an address in hand, password
 * login has an arbitrary identifier that resolves to one, and the OAuth callback
 * has one asserted by Google. A rule that applied at three of those four is the
 * failure mode worth designing against — it is silent, and the way you find out
 * is that someone walked in through the door nobody wired up.
 *
 * ─── Why there IS a cache now ─────────────────────────────────────────────
 *
 * This file used to carry the opposite comment, and it is worth keeping the
 * argument rather than deleting it, because half of it still holds.
 *
 * It said the lookup was one indexed query against a small table, and that what a
 * cache would add is a staleness window — on the one control where staleness is
 * the whole problem, since an operator blocks a domain precisely because it is
 * being abused right now, and a sixty-second TTL means sixty more seconds of
 * signups.
 *
 * The staleness objection is answered, not accepted. Invalidation is on the WRITE:
 * `block` drops the cache as part of adding a rule, so a newly blocked domain is
 * refused on the very next request. `BLOCKLIST.TTL_SECONDS` is a backstop for a
 * missed invalidation, not the freshness mechanism.
 *
 * The performance half of the old comment, though, was right, and it is worth
 * saying so here rather than letting the next reader assume this made things
 * faster. It did not: 33.6 ms warm against 27.9 ms cold on `POST /auth/register`,
 * local Postgres and local Redis — noise. `findMatching` is an index probe over at
 * most three values, so the table's size never mattered. What this buys is one
 * fewer query per authentication reaching the database, which is a load argument
 * and only shows up somewhere the database is not on localhost. See `BLOCKLIST` in
 * auth.constants.ts.
 *
 * ─── The direction this fails in ──────────────────────────────────────────
 *
 * Every cache miss, every Redis error, and every half-built table falls through to
 * Postgres, which is the authority. Nothing here can conclude "not blocked" from a
 * cache that is merely absent — that is the one wrong answer available, and
 * `CacheService.hashFields` returning `null` rather than an empty result is what
 * makes it unrepresentable.
 */
@Injectable()
export class BlocklistService {
  private readonly logger = new Logger('Blocklist');

  constructor(
    private readonly blocklist: BlocklistDbOperation,
    private readonly cache: CacheService,
  ) {}

  /**
   * Throw `email_domain_blocked` when a rule matches.
   *
   * The refusal names no rule. `reason` is for the operator reading the table,
   * not for the person being turned away — telling a caller *which* pattern
   * caught them is a free oracle for finding one that does not.
   */
  async assertNotBlocked(email: string): Promise<void> {
    const match = await this.findMatching(email);
    if (match === null) return;

    // Logged at the rule, not the address: the operator's question after adding a
    // block is "is it doing anything", and this is what answers it.
    this.logger.warn(
      { rule: match.value, kind: match.kind },
      'refused an email address on the blocklist',
    );
    throw new ProblemException({
      type: ERR.EMAIL_DOMAIN_BLOCKED,
      detail: 'This email address cannot be used. Please use a different address.',
    });
  }

  /**
   * The same question without the throw.
   *
   * For the one caller that must not react — `LoginService.requestOtp` answers
   * identically whether or not it sent a code, and an exception there would undo
   * that by making a blocked account distinguishable from an eligible one.
   */
  async isBlocked(email: string): Promise<boolean> {
    return (await this.findMatching(email)) !== null;
  }

  /**
   * Add rules, and drop the cache in the same breath.
   *
   * THE write path, and the reason the cache is safe. An operator adding a domain
   * expects it to take effect now, not when a TTL lapses, so the invalidation is
   * part of blocking rather than a periodic sweep.
   *
   * Invalidated AFTER the write and unconditionally — including when `blockMany`
   * inserted nothing. A zero count means every rule was already present, which is
   * the harmless case, but it can also mean a partial insert raced another writer;
   * dropping a cache that did not need dropping costs one rebuild, and not dropping
   * one that did costs an hour of a domain staying open.
   *
   * The seed calls `BlocklistDbOperation.blockMany` directly rather than coming
   * through here, and that is fine: it runs offline against a database nothing is
   * serving from yet, and the TTL covers the case where it does not.
   */
  async block(
    entries: readonly { value: string; reason?: string; createdBy?: string }[],
  ): Promise<number> {
    const added = await this.blocklist.blockMany(entries);
    await this.invalidate();
    this.logger.log({ requested: entries.length, added }, 'blocklist rules added; cache dropped');
    return added;
  }

  /** Drop the cached table. The next lookup rebuilds it. */
  async invalidate(): Promise<void> {
    await this.cache.setHash(KEYS.blocklist.rules(), new Map(), BLOCKLIST.TTL_SECONDS);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /**
   * The first rule matching the address or any of its parent domains.
   *
   * `blocklistCandidates` turns one address into the handful of values a rule could
   * be written against, so both the cache read and the database read ask about all
   * of them at once rather than a round trip per label.
   */
  private async findMatching(email: string): Promise<BlocklistMatch | null> {
    const candidates = blocklistCandidates(email);

    const cached = await this.cache.hashFields(KEYS.blocklist.rules(), candidates);
    if (cached !== null) {
      const index = cached.findIndex((kind) => kind !== null);
      if (index === -1) return null;
      return { value: candidates[index] as string, kind: cached[index] as BlockedEmailKind };
    }

    // Cold, invalidated, or Redis is unwell. Answer from the authority, and rebuild
    // behind the response rather than making this request wait for 8,400 rows.
    void this.warm();

    const match = await this.blocklist.findMatching(candidates);
    return match === null ? null : { value: match.value, kind: match.kind };
  }

  /**
   * Rebuild the cached table, once.
   *
   * `startCooldown` is a `SET NX EX`, so of the requests that arrive against a cold
   * cache exactly one loads the table and the rest carry on to Postgres. Without it
   * a restart under load would have every in-flight request pull eight thousand
   * rows simultaneously — the cache would arrive, and the stampede getting it there
   * would be worse than never having had one.
   *
   * Fire-and-forget and self-catching. Nothing about answering "is this address
   * blocked" depends on this succeeding; the caller has already gone to the
   * database.
   */
  private async warm(): Promise<void> {
    try {
      if (!(await this.cache.startCooldown(KEYS.blocklist.warming(), BLOCKLIST.WARM_LOCK_SECONDS))) {
        return;
      }

      const rules = await this.blocklist.listAll();
      await this.cache.setHash(
        KEYS.blocklist.rules(),
        new Map(rules.map((rule) => [rule.value, rule.kind])),
        BLOCKLIST.TTL_SECONDS,
      );
      this.logger.log({ rules: rules.length }, 'blocklist cache rebuilt');
    } catch (err) {
      this.logger.error({ err }, 'blocklist cache rebuild failed');
    }
  }
}
