import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { KycPolicyService } from '../../src/kyc/kyc-policy.service';
import { makePrincipal } from '../harness';

/**
 * The policy service against doubles.
 *
 * What is proved here is the ORCHESTRATION: which outcome becomes which error, what
 * the audit row carries, and that a lost compare-and-swap is reported as a stale
 * payload rather than swallowed. The SQL those outcomes come from is proved against a
 * real database in `kyc.postgres.spec.ts` — a double cannot tell you whether
 * `ON CONFLICT` infers the right index.
 */

const ACTOR = makePrincipal({ adminId: '0195f0a0-aaaa-7000-8000-000000000001' });
const CLIENT = { ip: '203.0.113.10', userAgent: 'vitest', acceptLanguage: 'en' } as never;

const UPSERT = {
  action: 'upsert' as const,
  region: 'IN',
  level: 'L1',
  enabled: true,
  required: true,
  triggersOnly: false,
  workflowId: null,
  renewalWorkflowId: null,
  balanceThreshold: null,
  lifetimeDepositThreshold: null,
  lifetimeWithdrawalThreshold: null,
  rollingWindowAmount: null,
  rollingWindowSeconds: null,
  rollingWindowOperation: null,
  thresholdCurrency: null,
  features: [] as string[],
  subFeatures: [] as Array<{ feature: string; subFeature: string }>,
  reason: 'Regulatory requirement.',
  expectedVersion: 0,
};

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    region: 'IN',
    level: 'L1',
    enabled: true,
    required: true,
    triggers_only: false,
    workflow_id: null,
    renewal_workflow_id: null,
    balance_threshold: null,
    lifetime_deposit_threshold: null,
    lifetime_withdrawal_threshold: null,
    rolling_window_amount: null,
    rolling_window_seconds: null,
    rolling_window_operation: null,
    threshold_currency: null,
    features: [],
    sub_features: [],
    version: 1,
    updated_by_admin_id: ACTOR.adminId,
    reason: 'Regulatory requirement.',
    updated_at: new Date('2026-09-15T10:00:00.000Z'),
    ...overrides,
  };
}

let policies: { list: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; history: ReturnType<typeof vi.fn> };
let events: { record: ReturnType<typeof vi.fn> };
let service: KycPolicyService;

beforeEach(() => {
  policies = {
    list: vi.fn().mockResolvedValue([storedRow()]),
    upsert: vi.fn().mockResolvedValue({ ok: true, version: 1 }),
    remove: vi.fn().mockResolvedValue({ ok: true, version: 2 }),
    history: vi.fn().mockResolvedValue([]),
  };
  events = { record: vi.fn().mockResolvedValue(undefined) };
  service = new KycPolicyService(policies as never, events as never);
});

describe('reading policy', () => {
  it('returns the configured rows plus the vocabularies a form needs', async () => {
    const state = await service.state();

    expect(state.policies).toHaveLength(1);
    expect(state.levels).toEqual(['L1', 'L2']);
    expect(state.rollingWindowOperations).toEqual(['WITHDRAWAL', 'DEPOSIT']);
    expect(state.globalRegion).toBe('*');
  });

  it('states the version a create must send, since no placeholder row exists to show it', async () => {
    // The precedent can enumerate its whole cross-product and hand back un-created
    // rows at version 0. This target space is every country times two levels, so the
    // create affordance has to be stated instead of discovered.
    expect((await service.state()).createVersion).toBe(0);
  });

  it('camel-cases the row and renders instants as ISO strings', async () => {
    const [view] = (await service.state()).policies;

    expect(view).toMatchObject({
      region: 'IN',
      triggersOnly: false,
      updatedAt: '2026-09-15T10:00:00.000Z',
    });
  });

  it('reports a row the consumer would act on as in force', async () => {
    expect((await service.state()).policies[0]?.enforcementRejection).toBeNull();
  });

  /**
   * The canary, exercised against rows the database would refuse today.
   *
   * `ck_kyc_policies_level` and `ck_kyc_policies_threshold_currency` make both of these
   * unstorable, so neither can occur while the constraints are in place — which is
   * precisely what this readback is for. If a migration ever drops one, a row the
   * consumer will silently discard becomes storable, and this is what would say so.
   */
  it('flags a level the consumer could not read, were the constraint ever dropped', async () => {
    policies.list.mockResolvedValue([storedRow({ level: 'L3' })]);

    expect((await service.state()).policies[0]?.enforcementRejection).toBe('unknown_level');
  });

  it('flags a threshold with no currency, were the constraint ever dropped', async () => {
    policies.list.mockResolvedValue([storedRow({ balance_threshold: '100' })]);

    expect((await service.state()).policies[0]?.enforcementRejection).toBe(
      'threshold_without_currency',
    );
  });

  it('does NOT flag a lowercase region, because the consumer normalises it too', async () => {
    // Worth pinning: the mirror uppercases exactly as `normaliseRegion` does, so a
    // lowercase value is not a divergence. (It is unstorable anyway —
    // `ck_kyc_policies_region` requires uppercase — but the mirror must agree with the
    // consumer rather than with the constraint.)
    policies.list.mockResolvedValue([storedRow({ region: 'in' })]);

    expect((await service.state()).policies[0]?.enforcementRejection).toBeNull();
  });
});

describe('writing policy', () => {
  it('stores what was asked and returns the whole table', async () => {
    const state = await service.upsert(UPSERT, ACTOR, CLIENT);

    expect(policies.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'IN', level: 'L1', expectedVersion: 0 }),
    );
    // Returning the state means a screen never has to follow a write with a read, and
    // sees the version its next edit must send.
    expect(state.policies).toHaveLength(1);
  });

  it('attributes the write to the acting admin', async () => {
    await service.upsert(UPSERT, ACTOR, CLIENT);

    expect(policies.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ actorAdminId: ACTOR.adminId }),
    );
  });

  it('joins a sub-feature pair into the spelling the column holds', async () => {
    // The DTO takes a structured pair so neither half can contain the delimiter; the
    // column holds `feature/subFeature`, which is what the consumer splits on read.
    await service.upsert(
      { ...UPSERT, subFeatures: [{ feature: 'wallet', subFeature: 'withdraw' }] },
      ACTOR,
      CLIENT,
    );

    expect(policies.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ subFeatures: ['wallet/withdraw'] }),
    );
  });

  it('records an audit event carrying the two version numbers', async () => {
    await service.upsert(UPSERT, ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ADMIN_KYC_POLICY_UPDATED',
        adminId: ACTOR.adminId,
        metadata: expect.objectContaining({ fromVersion: 0, toVersion: 1, removed: false }),
      }),
    );
  });

  it('puts only flat scalars in the audit metadata', async () => {
    // The column is serialised into an API response by the review queue, and the
    // contract is slugs and counts only.
    await service.upsert(UPSERT, ACTOR, CLIENT);

    const { metadata } = events.record.mock.calls[0]![0] as {
      metadata: Record<string, unknown>;
    };
    for (const value of Object.values(metadata)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });
});

describe('the compare-and-swap', () => {
  it('reports a stale read as a 400 on expectedVersion, not a 409', async () => {
    // The precedent's explicit choice: from the caller's side this is a stale payload,
    // and the remedy is to re-read and re-present rather than to retry.
    policies.upsert.mockResolvedValue({ ok: false, currentVersion: 4 });

    const failure = await service.upsert({ ...UPSERT, expectedVersion: 2 }, ACTOR, CLIENT).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(ProblemException);
    expect((failure as ProblemException).type).toBe(ERR.VALIDATION_FAILED);
    expect((failure as ProblemException).errors?.[0]?.path).toBe('expectedVersion');
    expect((failure as ProblemException).errors?.[0]?.message).toContain('version 4');
  });

  it('tells a caller to CREATE when no row exists, rather than citing version 0', async () => {
    // The bug inherited from the precedent, fixed: reporting "it is now at version 0"
    // names a version nothing ever had and gives the operator nothing to act on.
    policies.upsert.mockResolvedValue({ ok: false, currentVersion: 0 });

    const failure = await service.upsert({ ...UPSERT, expectedVersion: 3 }, ACTOR, CLIENT).catch(
      (err: unknown) => err,
    );

    expect((failure as ProblemException).errors?.[0]?.message).toContain('expectedVersion: 0');
    expect((failure as ProblemException).errors?.[0]?.message).not.toContain('version 0,');
  });

  it('records no audit event when the write was refused', async () => {
    policies.upsert.mockResolvedValue({ ok: false, currentVersion: 4 });

    await service.upsert(UPSERT, ACTOR, CLIENT).catch(() => undefined);

    expect(events.record).not.toHaveBeenCalled();
  });
});

describe('removing policy', () => {
  const REMOVE = {
    action: 'delete' as const,
    region: 'IN',
    level: 'L1',
    reason: 'India now follows the global rule.',
    expectedVersion: 1,
  };

  it('removes the row so the region falls back to the global rule', async () => {
    await service.remove(REMOVE, ACTOR, CLIENT);

    expect(policies.remove).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'IN', level: 'L1', expectedVersion: 1 }),
    );
  });

  it('marks the audit event as a removal', async () => {
    await service.remove(REMOVE, ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ADMIN_KYC_POLICY_UPDATED',
        metadata: expect.objectContaining({ removed: true, fromVersion: 1, toVersion: 2 }),
      }),
    );
  });

  it('refuses a removal whose expected version is stale', async () => {
    policies.remove.mockResolvedValue({ ok: false, currentVersion: 7 });

    const failure = await service.remove(REMOVE, ACTOR, CLIENT).catch((err: unknown) => err);

    expect((failure as ProblemException).type).toBe(ERR.VALIDATION_FAILED);
  });
});

describe('history', () => {
  it('asks for the requested target and limit', async () => {
    await service.history({ region: 'IN', level: 'L2', limit: 10 });

    expect(policies.history).toHaveBeenCalledWith('IN', 'L2', 10);
  });
});
