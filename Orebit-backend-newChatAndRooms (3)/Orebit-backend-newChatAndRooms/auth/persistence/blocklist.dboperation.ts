import { Injectable } from '@nestjs/common';
import type { BlockedEmail, BlockedEmailKind } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { classifyBlocklistValue } from '../security/blocklist';

/**
 * Persistence for `blocked_emails` — the admin-managed email blocklist.
 *
 * Three methods. `findMatching` is the request path, `blockMany` is every write
 * there is — the seed uses it today and an admin route will use it tomorrow — and
 * `listAll` exists to populate the Redis cache in front of `findMatching`.
 * Unblocking arrives with the admin surface that needs it, rather than sitting here
 * unused and untested until then.
 */
@Injectable()
export class BlocklistDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The first rule matching any of `values`, or null.
   *
   * One query for the whole candidate set — the address and each of its parent
   * domains — because `value` is uniquely indexed across both kinds. Checking
   * them one at a time would be a round trip per label on every login.
   */
  async findMatching(values: readonly string[]): Promise<BlockedEmail | null> {
    if (values.length === 0) return null;
    return this.prisma.blockedEmail.findFirst({ where: { value: { in: [...values] } } });
  }

  /**
   * Every rule, for the cache to hold.
   *
   * Only `value` and `kind` are selected. `reason` and `createdBy` are for an
   * operator reading the table, never for a decision, so shipping them into Redis
   * for eight thousand rows would be bytes spent on nothing.
   *
   * Unpaginated on purpose: the caller is loading a complete lookup table, and a
   * partial one would silently under-block. If this table ever grows past what one
   * query should return, the cache shape is what needs rethinking — not this.
   */
  async listAll(): Promise<{ value: string; kind: BlockedEmailKind }[]> {
    return this.prisma.blockedEmail.findMany({ select: { value: true, kind: true } });
  }

  /**
   * Add rules, ignoring any that already exist.
   *
   * `kind` is derived from each value rather than passed in, which is what makes
   * the column incapable of disagreeing with the value it describes. A value that
   * is neither a usable address nor a usable domain is skipped rather than
   * stored — a malformed rule matches nothing, so writing it would only be a row
   * that looks like protection and is not.
   *
   * Returns the number of rows actually inserted, so the seed can report what it
   * did rather than what it attempted.
   */
  async blockMany(
    entries: readonly { value: string; reason?: string; createdBy?: string }[],
  ): Promise<number> {
    const rows = entries.flatMap((entry) => {
      const classified = classifyBlocklistValue(entry.value);
      if (classified === null) return [];
      return [
        {
          id: uuidv7(),
          kind: classified.kind,
          value: classified.value,
          reason: entry.reason ?? null,
          createdBy: entry.createdBy ?? null,
        },
      ];
    });

    if (rows.length === 0) return 0;

    // `skipDuplicates` rather than an upsert loop: re-running the seed, or an
    // admin re-adding a domain someone already blocked, is not an error and must
    // not overwrite the original row's reason and author.
    const { count } = await this.prisma.blockedEmail.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return count;
  }
}
