import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../db/client';
import { ChallengeDbOperation } from '../../../auth/persistence/challenge.dboperation';

const INPUT = {
  userId: 'user-1',
  purpose: 'LOGIN_OTP' as const,
  codeHash: 'a'.repeat(64),
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  ipAddress: '203.0.113.7',
};

let updateMany: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
let transaction: ReturnType<typeof vi.fn>;
let ops: ChallengeDbOperation;

beforeEach(() => {
  updateMany = vi.fn().mockResolvedValue({ count: 1 });
  create = vi.fn().mockImplementation(async ({ data }: { data: unknown }) => data);
  const tx = { verificationChallenge: { updateMany, create } };
  transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

  ops = new ChallengeDbOperation(
    {
      verificationChallenge: { updateMany, create },
      $transaction: transaction,
    } as unknown as PrismaService,
  );
});

describe('ChallengeDbOperation.issue — OTP supersession', () => {
  it('consumes every prior live challenge before storing the replacement', async () => {
    await ops.issue(INPUT);

    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: INPUT.userId, purpose: INPUT.purpose, consumedAt: null },
      data: { consumedAt: expect.any(Date) as unknown as Date },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: INPUT.userId,
        purpose: INPUT.purpose,
        codeHash: INPUT.codeHash,
      }),
    });
  });

  it('retries once when a simultaneous issuance wins the live-code constraint', async () => {
    let calls = 0;
    transaction.mockImplementation(async (fn: (t: { verificationChallenge: { updateMany: typeof updateMany; create: typeof create } }) => Promise<unknown>) => {
      calls += 1;
      const result = await fn({ verificationChallenge: { updateMany, create } });
      if (calls === 1) throw { code: 'P2002' };
      return result;
    });

    await expect(ops.issue(INPUT)).resolves.toMatchObject({
      userId: INPUT.userId,
      purpose: INPUT.purpose,
    });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
