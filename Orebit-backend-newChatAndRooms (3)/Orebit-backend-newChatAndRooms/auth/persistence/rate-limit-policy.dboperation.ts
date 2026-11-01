import { Injectable } from '@nestjs/common';
import type { Policy } from '../limits';
import { uuidv7 } from '../../src/utils/public.utils';
import { PrismaService } from '../../db/client';

/** Durable snapshots for the runtime rate-limit policy. */
@Injectable()
export class RateLimitPolicyDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  async active(): Promise<{ version: number; policy: Policy } | null> {
    const row = await this.prisma.rateLimitPolicyVersion.findFirst({
      where: { active: true },
      orderBy: { version: 'desc' },
      select: { version: true, policy: true },
    });
    return row === null ? null : { version: row.version, policy: row.policy as unknown as Policy };
  }

  /** Append a new audited version, atomically replacing the live snapshot. */
  async activate(actor: string, policy: Policy): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.rateLimitPolicyVersion.aggregate({ _max: { version: true } });
      const version = (latest._max.version ?? 0) + 1;
      await tx.rateLimitPolicyVersion.updateMany({ where: { active: true }, data: { active: false } });
      await tx.rateLimitPolicyVersion.create({
        data: { id: uuidv7(), version, actor, policy: policy as never, active: true },
      });
      return version;
    });
  }
}
