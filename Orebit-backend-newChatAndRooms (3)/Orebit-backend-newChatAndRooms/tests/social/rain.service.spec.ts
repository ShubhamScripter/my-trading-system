import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RAIN_CONFIG } from '../../src/social/rain/rain.contract';
import { RainService, type UserRainInput } from '../../src/social/rain/rain.service';
import type { RainRunRow } from '../../src/social/rain/rain.types';
import { uuidv7 } from '../../src/utils/public.utils';

const USER = { id: uuidv7() };
const ROOM = { id: uuidv7() };
const INPUT: UserRainInput = {
  roomId: ROOM.id,
  currency: 'BTC',
  pot: 1_000_000n,
  recipients: { mode: 'SPECIFIC', count: 2 },
  repeatCount: null,
  repeatGapSeconds: null,
  clientMessageId: 'client-message-1',
};

function makeService(existing: RainRunRow | null = null, spendable = 10_000_000n) {
  const config = structuredClone(DEFAULT_RAIN_CONFIG);
  config.status.user = 'ON';
  config.user.currencies = { all: true, codes: [] };
  config.user.channels = { all: true, roomIds: [] };
  config.user.maxAmount = { mode: 'USD', usd: '1000', perCurrency: [] };

  const run: RainRunRow = {
    id: uuidv7(),
    kind: 'USER',
    status: 'COMPLETED',
    roomId: ROOM.id,
    initiatorId: USER.id,
    currency: 'BTC',
    potMinor: INPUT.pot,
    feeMinor: 20_000n,
    distributableMinor: 980_000n,
    idempotencyKey: `user:${USER.id}:${INPUT.clientMessageId}`,
    messageId: null,
    requestedRecipients: 2,
    recipientRule: INPUT.recipients,
    repeatCount: null,
    repeatGapSeconds: null,
    usdPriceMinor: 6_000_000_000_000n,
    usdValueMinor: 600_000_000n,
  };
  const tx = {};
  const prisma = { $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx)) };
  const db = {
    config: vi.fn().mockResolvedValue(config),
    findByKey: vi.fn().mockResolvedValue(existing),
    insertRun: vi.fn().mockResolvedValue(undefined),
    insertShares: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(run),
  };
  const wallet = {
    refuseIfUnavailable: vi.fn(),
    spendable: vi.fn().mockResolvedValue(spendable),
    ensurePayer: vi.fn().mockResolvedValue(undefined),
    apply: vi.fn().mockResolvedValue(undefined),
  };
  const payout = {
    legsOf: vi.fn().mockReturnValue([{ userId: USER.id, delta: -1_000_000n }]),
    afterPaid: vi.fn().mockResolvedValue({ rainId: run.id, status: 'COMPLETED' }),
  };
  const service = Object.assign(Object.create(RainService.prototype), {
    prisma,
    db,
    wallet,
    access: {
      requireRoom: vi.fn().mockResolvedValue(ROOM),
      evaluate: vi.fn().mockResolvedValue({ isEligibleToWrite: true, reason: null }),
    },
    chatPorts: { rainEntitlements: vi.fn().mockResolvedValue(null) },
    rainPorts: { usdPrice: vi.fn().mockResolvedValue(6_000_000_000_000n) },
    selection: {
      eligible: vi.fn().mockResolvedValue([
        { id: uuidv7(), planIds: [] },
        { id: uuidv7(), planIds: [] },
      ]),
      shuffle: vi.fn((people: unknown[]) => people),
    },
    payout,
    series: { scheduleRepeatOf: vi.fn().mockResolvedValue(undefined) },
    scheduler: {},
    revertService: {},
  }) as unknown as RainService;
  return { service, run, db, wallet, payout, prisma };
}

describe('user rain money path', () => {
  it('charges once and records the run and each share in the same transaction', async () => {
    const { service, db, wallet, payout, prisma } = makeService();

    await service.executeUserCommand(USER as never, INPUT);

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(wallet.ensurePayer).toHaveBeenCalledOnce();
    expect(wallet.apply).toHaveBeenCalledOnce();
    expect(db.insertRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recipientCount: 2, idempotencyKey: `user:${USER.id}:${INPUT.clientMessageId}` }),
    );
    expect(db.insertShares).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(Array));
    expect(payout.afterPaid).toHaveBeenCalledOnce();
  });

  it('answers an idempotent retry without charging or inserting another run', async () => {
    const existing = {
      id: uuidv7(), kind: 'USER', status: 'COMPLETED', roomId: ROOM.id, initiatorId: USER.id,
      currency: 'BTC', potMinor: INPUT.pot, feeMinor: 20_000n, distributableMinor: 980_000n,
      idempotencyKey: `user:${USER.id}:${INPUT.clientMessageId}`, messageId: null, requestedRecipients: 2,
    } as RainRunRow;
    const { service, db, wallet, prisma } = makeService(existing);

    const result = await service.executeUserCommand(USER as never, INPUT);

    expect(result.rainId).toBe(existing.id);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(wallet.apply).not.toHaveBeenCalled();
    expect(db.insertRun).not.toHaveBeenCalled();
  });

  it('refuses insufficient balance before opening the payment transaction', async () => {
    const { service, wallet, prisma, db } = makeService(null, INPUT.pot - 1n);

    await expect(service.executeUserCommand(USER as never, INPUT)).rejects.toThrow(/Not enough BTC/);

    expect(wallet.apply).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.insertRun).not.toHaveBeenCalled();
  });
});
