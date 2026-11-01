import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheService } from '../../redis';
import type { BlocklistDbOperation } from '../../auth/persistence/blocklist.dboperation';
import { BlocklistService } from '../../auth/services/blocklist.service';
import { blocklistCandidates, classifyBlocklistValue } from '../../auth/security/blocklist';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * The blocklist, at its two seams.
 *
 * `blocklistCandidates` and `classifyBlocklistValue` are inverses, and the last
 * describe block is the one that matters most: it asserts the round trip, because
 * the failure mode they can produce together is a rule that stores fine and
 * matches nothing.
 */

describe('blocklistCandidates', () => {
  it('offers the address itself first', () => {
    expect(blocklistCandidates('user@mailinator.com')[0]).toBe('user@mailinator.com');
  });

  it('offers every parent domain, so a wildcard provider needs one rule', () => {
    expect(blocklistCandidates('user@team.mail.mailinator.com')).toEqual([
      'user@team.mail.mailinator.com',
      'team.mail.mailinator.com',
      'mail.mailinator.com',
      'mailinator.com',
    ]);
  });

  it('never offers a bare TLD — a `com` rule must be unable to match anything', () => {
    expect(blocklistCandidates('user@mailinator.com')).not.toContain('com');
    expect(blocklistCandidates('a@b.c.d.e')).not.toContain('e');
  });

  it('normalises case and surrounding whitespace', () => {
    expect(blocklistCandidates('  User@MailInator.COM ')).toEqual([
      'user@mailinator.com',
      'mailinator.com',
    ]);
  });

  it('splits on the LAST @, so a quoted local-part cannot forge a domain', () => {
    expect(blocklistCandidates('"a@evil.com"@mailinator.com')).toContain('mailinator.com');
  });

  it('returns nothing for a value that is not an address', () => {
    expect(blocklistCandidates('not-an-email')).toEqual([]);
    expect(blocklistCandidates('trailing@')).toEqual([]);
  });
});

describe('classifyBlocklistValue', () => {
  it('reads a full address as an EMAIL rule', () => {
    expect(classifyBlocklistValue('User@Mailinator.com')).toEqual({
      kind: 'EMAIL',
      value: 'user@mailinator.com',
    });
  });

  it('reads a bare domain as a DOMAIN rule', () => {
    expect(classifyBlocklistValue('Mailinator.com')).toEqual({
      kind: 'DOMAIN',
      value: 'mailinator.com',
    });
  });

  it.each(['@mailinator.com', '*.mailinator.com', '.mailinator.com', '  mailinator.com  '])(
    'accepts %s as the same DOMAIN rule, because operators type all of these',
    (typed) => {
      expect(classifyBlocklistValue(typed)).toEqual({
        kind: 'DOMAIN',
        value: 'mailinator.com',
      });
    },
  );

  it('rejects a single label — it could only ever be a TLD', () => {
    expect(classifyBlocklistValue('com')).toBeNull();
    expect(classifyBlocklistValue('localhost')).toBeNull();
  });

  it('rejects values that could never match an address', () => {
    expect(classifyBlocklistValue('')).toBeNull();
    expect(classifyBlocklistValue('   ')).toBeNull();
    expect(classifyBlocklistValue('@')).toBeNull();
    expect(classifyBlocklistValue('user@')).toBeNull();
    expect(classifyBlocklistValue('user@not_a_domain')).toBeNull();
  });
});

describe('the two are inverses', () => {
  // The regression this file exists for: a rule that is accepted, is visible in
  // the table, and silently matches nothing.
  it.each([
    ['mailinator.com', 'someone@mailinator.com'],
    ['@mailinator.com', 'someone@mailinator.com'],
    ['*.mailinator.com', 'someone@team.mailinator.com'],
    ['MailInator.com', 'SOMEONE@MAILINATOR.COM'],
    ['someone@mailinator.com', 'someone@mailinator.com'],
    ['co.uk.temp.example', 'x@co.uk.temp.example'],
  ])('a rule stored as %s matches %s', (typed, address) => {
    const stored = classifyBlocklistValue(typed);
    expect(stored).not.toBeNull();
    expect(blocklistCandidates(address)).toContain(stored!.value);
  });

  it('an EMAIL rule does not leak into a DOMAIN match', () => {
    const stored = classifyBlocklistValue('someone@mailinator.com')!;
    // A different local-part on the same domain must NOT be caught by an address
    // rule — that is what a DOMAIN rule is for.
    expect(blocklistCandidates('other@mailinator.com')).not.toContain(stored.value);
  });
});

describe('BlocklistService', () => {
  let db: {
    findMatching: ReturnType<typeof vi.fn>;
    listAll: ReturnType<typeof vi.fn>;
    blockMany: ReturnType<typeof vi.fn>;
  };
  let cache: {
    hashFields: ReturnType<typeof vi.fn>;
    setHash: ReturnType<typeof vi.fn>;
    startCooldown: ReturnType<typeof vi.fn>;
  };
  let service: BlocklistService;

  beforeEach(() => {
    db = {
      findMatching: vi.fn().mockResolvedValue(null),
      listAll: vi.fn().mockResolvedValue([]),
      blockMany: vi.fn().mockResolvedValue(0),
    };
    // `hashFields` answering null is a COLD cache, which is the state the existing
    // assertions below were written against: every lookup falls through to
    // Postgres. Keeping it as the default is deliberate — it means those tests go
    // on testing the authority path rather than quietly becoming tests of a mock.
    cache = {
      hashFields: vi.fn().mockResolvedValue(null),
      setHash: vi.fn().mockResolvedValue(undefined),
      startCooldown: vi.fn().mockResolvedValue(false),
    };
    service = new BlocklistService(
      db as unknown as BlocklistDbOperation,
      cache as unknown as CacheService,
    );
  });

  it('passes the whole candidate set in ONE query', async () => {
    await service.assertNotBlocked('user@team.mailinator.com');

    expect(db.findMatching).toHaveBeenCalledTimes(1);
    expect(db.findMatching).toHaveBeenCalledWith([
      'user@team.mailinator.com',
      'team.mailinator.com',
      'mailinator.com',
    ]);
  });

  it('resolves when nothing matches', async () => {
    await expect(service.assertNotBlocked('user@example.com')).resolves.toBeUndefined();
  });

  it('throws email_domain_blocked when a rule matches', async () => {
    db.findMatching.mockResolvedValue({ value: 'mailinator.com', kind: 'DOMAIN', reason: 'temp mail' });

    const err = await service.assertNotBlocked('user@mailinator.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).type).toBe(ERR.EMAIL_DOMAIN_BLOCKED);
    expect((err as ProblemException).status).toBe(400);
  });

  it('never names the rule that caught them', async () => {
    db.findMatching.mockResolvedValue({
      value: 'mailinator.com',
      kind: 'DOMAIN',
      reason: 'internal note about the abuse campaign',
    });

    const err = (await service
      .assertNotBlocked('user@mailinator.com')
      .catch((e: unknown) => e)) as ProblemException;

    // Telling a caller which pattern matched is a free oracle for finding one
    // that does not.
    const body = `${err.message} ${JSON.stringify({ detail: err.detail, extra: err.extra })}`;
    expect(body).not.toContain('mailinator');
    expect(body).not.toContain('abuse campaign');
  });

  it('isBlocked answers without throwing, for the path that must stay silent', async () => {
    db.findMatching.mockResolvedValue({ value: 'mailinator.com', kind: 'DOMAIN' });
    await expect(service.isBlocked('user@mailinator.com')).resolves.toBe(true);

    db.findMatching.mockResolvedValue(null);
    await expect(service.isBlocked('user@example.com')).resolves.toBe(false);
  });
});

/**
 * ═══ THE CACHE, AND THE DIRECTION IT FAILS IN ══════════════════════════════
 *
 * This service argued against a cache for a long time, on the grounds that
 * staleness is unacceptable for a control an operator reaches for while abuse is
 * happening. The cache exists now because invalidation is on the WRITE rather than
 * on a clock — so these tests are mostly about that, and about the one wrong answer
 * available here: concluding "not blocked" from a cache that is merely absent.
 */
describe('BlocklistService — the cache', () => {
  let db: {
    findMatching: ReturnType<typeof vi.fn>;
    listAll: ReturnType<typeof vi.fn>;
    blockMany: ReturnType<typeof vi.fn>;
  };
  let cache: {
    hashFields: ReturnType<typeof vi.fn>;
    setHash: ReturnType<typeof vi.fn>;
    startCooldown: ReturnType<typeof vi.fn>;
  };
  let service: BlocklistService;

  beforeEach(() => {
    db = {
      findMatching: vi.fn().mockResolvedValue(null),
      listAll: vi.fn().mockResolvedValue([{ value: 'mailinator.com', kind: 'DOMAIN' }]),
      blockMany: vi.fn().mockResolvedValue(1),
    };
    cache = {
      hashFields: vi.fn().mockResolvedValue(null),
      setHash: vi.fn().mockResolvedValue(undefined),
      startCooldown: vi.fn().mockResolvedValue(true),
    };
    service = new BlocklistService(
      db as unknown as BlocklistDbOperation,
      cache as unknown as CacheService,
    );
  });

  /** Let the fire-and-forget rebuild settle. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('answers a warm cache without touching Postgres', async () => {
    // `HMGET` returns one entry per candidate, in order. A non-null entry is the
    // rule's kind, and its position names which candidate matched.
    cache.hashFields.mockResolvedValue([null, null, 'DOMAIN']);

    await expect(service.isBlocked('user@team.mailinator.com')).resolves.toBe(true);
    expect(db.findMatching).not.toHaveBeenCalled();
  });

  it('reports the matched rule, not just that something matched', async () => {
    // The log line an operator reads after adding a block is "is it doing
    // anything", and it names the rule. The field NAME is the matched value, so the
    // position in the result is what recovers it.
    cache.hashFields.mockResolvedValue([null, null, 'DOMAIN']);

    const err = await service.assertNotBlocked('user@team.mailinator.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).type).toBe(ERR.EMAIL_DOMAIN_BLOCKED);
  });

  it('treats an all-null warm result as genuinely not blocked', async () => {
    cache.hashFields.mockResolvedValue([null, null, null]);

    await expect(service.isBlocked('user@example.com')).resolves.toBe(false);
    expect(db.findMatching).not.toHaveBeenCalled();
  });

  it('NEVER concludes "not blocked" from an absent cache', async () => {
    // ═══ THE ONE WRONG ANSWER ═════════════════════════════════════════════════
    //
    // `hashFields` returns null for a cold cache, an invalidated one, and a Redis
    // failure alike. If any of those read as "no match" the blocklist would silently
    // stop working the moment Redis blinked — the failure mode that made this
    // service refuse a cache for so long. It must go to the authority instead.
    cache.hashFields.mockResolvedValue(null);
    db.findMatching.mockResolvedValue({ value: 'mailinator.com', kind: 'DOMAIN' });

    await expect(service.isBlocked('user@mailinator.com')).resolves.toBe(true);
    expect(db.findMatching).toHaveBeenCalledTimes(1);
  });

  it('rebuilds behind the response rather than making the caller wait', async () => {
    await service.isBlocked('user@example.com');

    // Answered from Postgres already; the rebuild has not necessarily run yet.
    expect(db.findMatching).toHaveBeenCalledTimes(1);
    await settle();
    expect(db.listAll).toHaveBeenCalledTimes(1);
    expect(cache.setHash).toHaveBeenCalled();
  });

  it('rebuilds ONCE when several requests hit a cold cache', async () => {
    // `startCooldown` is a SET NX EX. Without it a restart under load would have
    // every in-flight request pull the whole table at once, and the stampede would
    // be worse than having no cache.
    cache.startCooldown.mockResolvedValueOnce(true).mockResolvedValue(false);

    await Promise.all([
      service.isBlocked('a@example.com'),
      service.isBlocked('b@example.com'),
      service.isBlocked('c@example.com'),
    ]);
    await settle();

    expect(db.listAll).toHaveBeenCalledTimes(1);
  });

  it('keeps answering when the rebuild itself fails', async () => {
    cache.startCooldown.mockRejectedValue(new Error('redis down'));
    db.findMatching.mockResolvedValue({ value: 'mailinator.com', kind: 'DOMAIN' });

    await expect(service.isBlocked('user@mailinator.com')).resolves.toBe(true);
  });

  it('drops the cache as part of adding a rule', async () => {
    // THE property the whole design rests on. An operator blocks a domain because
    // it is being abused right now; it has to bite on the next request, not when a
    // TTL lapses.
    await service.block([{ value: 'evil.example' }]);

    expect(db.blockMany).toHaveBeenCalled();
    expect(cache.setHash).toHaveBeenCalledWith(expect.any(String), new Map(), expect.any(Number));
  });

  it('drops the cache even when every rule was already present', async () => {
    // A zero count is usually harmless — but it can also mean a partial insert
    // raced another writer. Dropping a cache that did not need it costs one
    // rebuild; not dropping one that did costs an hour of an open door.
    db.blockMany.mockResolvedValue(0);

    await service.block([{ value: 'evil.example' }]);

    expect(cache.setHash).toHaveBeenCalled();
  });
});
