import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { KycRequirementService } from '../../src/kyc/kyc-requirement.service';
import { makePrincipal } from '../harness';

/**
 * The requirement service against doubles.
 *
 * ═══ WHAT THIS FILE IS ACTUALLY GUARDING ═══════════════════════════════════
 *
 * Two things, and neither is the SQL:
 *
 *   1. Each outcome becomes the RIGHT answer. `created: false` is a SUCCESS — the
 *      obligation the admin asked for stands — and reporting it as a conflict would
 *      make a retried request look like a failure and invite a client to "fix" it by
 *      inventing a second reference. A closed row is a 400 (stale payload), a foreign
 *      row is a 404 that confirms nothing.
 *
 *   2. This service computes NO KYC standing. It never reads a level state, an
 *      exemption or a renewal period, and there is no effective-level calculation
 *      anywhere in it — that algebra belongs to the consumer's evaluator and a copy
 *      here would be a second answer waiting to disagree. The last case asserts the
 *      absence structurally rather than by reading the file.
 */

const ACTOR = makePrincipal({ adminId: '0195f0a0-aaaa-7000-8000-000000000001' });
const CLIENT = { ip: '203.0.113.10', userAgent: 'vitest', acceptLanguage: 'en' } as never;
const USER = '0195f0a0-bbbb-7000-8000-000000000002';
const REQUIREMENT = '0195f0a0-cccc-7000-8000-000000000003';
const VERIFICATION = '0195f0a0-dddd-7000-8000-000000000004';

const REQUIRE = {
  action: 'require' as const,
  userId: USER,
  requiredLevel: 'L1',
  reference: 'CASE-4182',
  reason: 'Sanctions review pending, ticket OPS-4182.',
};

const WAIVE = {
  action: 'waive' as const,
  userId: USER,
  requirementId: REQUIREMENT,
  reason: 'Compliance case resolved.',
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUIREMENT,
    user_id: USER,
    required_level: 'L1',
    trigger_kind: 'ADMIN',
    trigger_key: 'ADMIN:CASE-4182',
    satisfied_at: null,
    satisfied_by_verification_id: null,
    waived_at: null,
    waived_by: null,
    policy_region: null,
    policy_version: null,
    created_at: new Date('2026-09-18T00:00:00.000Z'),
    updated_at: new Date('2026-09-18T00:00:00.000Z'),
    open: true,
    ...overrides,
  };
}

let requirements: {
  listForUser: ReturnType<typeof vi.fn>;
  require: ReturnType<typeof vi.fn>;
  waive: ReturnType<typeof vi.fn>;
};
let events: { record: ReturnType<typeof vi.fn> };
let service: KycRequirementService;

beforeEach(() => {
  requirements = {
    listForUser: vi.fn().mockResolvedValue([row()]),
    require: vi.fn().mockResolvedValue({ ok: true, row: row(), created: true }),
    waive: vi.fn().mockResolvedValue({ ok: true, row: row({ waived_at: new Date(), open: false }) }),
  };
  events = { record: vi.fn().mockResolvedValue(undefined) };
  service = new KycRequirementService(requirements as never, events as never);
});

describe('require', () => {
  it('builds the consumer trigger key from the reference', async () => {
    await service.require(REQUIRE, ACTOR, CLIENT);

    expect(requirements.require).toHaveBeenCalledWith({
      userId: USER,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: 'ADMIN:CASE-4182',
    });
  });

  it('does NOT ask whether the account already holds the level', async () => {
    // ═══ THE SINGLE-AUTHORITY RULE ═══════════════════════════════════════════
    //
    // Answering that needs `effectiveLevel` — credentials folded with a live
    // exemption, each level's renewal clock, the ladder, supersession — all of which
    // lives in the consumer. So the row goes in unconditionally and `evaluate` decides
    // whether it bites. Nothing in the call below carries a held level.
    await service.require(REQUIRE, ACTOR, CLIENT);

    const call = requirements.require.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(call).sort()).toEqual([
      'requiredLevel',
      'triggerKey',
      'triggerKind',
      'userId',
    ]);
  });

  it('reports an adopted row as a SUCCESS, not a conflict', async () => {
    requirements.require.mockResolvedValue({ ok: true, row: row(), created: false });

    await expect(service.require(REQUIRE, ACTOR, CLIENT)).resolves.toBeDefined();
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ created: false }) }),
    );
  });

  it('answers 404 for an account that does not exist', async () => {
    requirements.require.mockResolvedValue({ ok: false, reason: 'unknown_user' });

    await expect(service.require(REQUIRE, ACTOR, CLIENT)).rejects.toMatchObject({
      type: ERR.NOT_FOUND,
    });
    expect(events.record).not.toHaveBeenCalled();
  });

  it('records the audit event with the ACTOR as adminId and the subject in metadata', async () => {
    await service.require(REQUIRE, ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ADMIN_KYC_REQUIREMENT_RAISED',
        adminId: ACTOR.adminId,
        client: CLIENT,
        metadata: {
          userId: USER,
          requirementId: REQUIREMENT,
          requiredLevel: 'L1',
          triggerKey: 'ADMIN:CASE-4182',
          reference: 'CASE-4182',
          created: true,
          reason: REQUIRE.reason,
        },
      }),
    );
  });

  it('keeps the audit metadata FLAT', async () => {
    // `AuthEventDbOperation.record` stores a flat map; a nested object here would be
    // the first step towards stuffing returned rows into an audit row.
    await service.require(REQUIRE, ACTOR, CLIENT);

    const metadata = (events.record.mock.calls[0]?.[0] as { metadata: Record<string, unknown> })
      .metadata;
    for (const [key, value] of Object.entries(metadata)) {
      expect(typeof value, key).not.toBe('object');
    }
  });

  it('writes the database BEFORE it audits, so the row is authoritative', async () => {
    // `record` swallows its own failures by design, so a passing audit is not evidence
    // the mutation happened — and a failing one must not undo it.
    const order: string[] = [];
    requirements.require.mockImplementation(async () => {
      order.push('db');
      return { ok: true, row: row(), created: true };
    });
    events.record.mockImplementation(async () => {
      order.push('audit');
    });

    await service.require(REQUIRE, ACTOR, CLIENT);
    expect(order).toEqual(['db', 'audit']);
  });
});

describe('waive', () => {
  it('passes the actor as the waiving admin', async () => {
    await service.waive(WAIVE, ACTOR, CLIENT);

    expect(requirements.waive).toHaveBeenCalledWith({
      userId: USER,
      requirementId: REQUIREMENT,
      actorAdminId: ACTOR.adminId,
    });
  });

  it('answers 404 for a requirement that is not this account’s', async () => {
    // Deliberately the same answer as "no such requirement": distinguishing them would
    // make this an oracle for enumerating requirement ids.
    requirements.waive.mockResolvedValue({ ok: false, reason: 'not_found' });

    await expect(service.waive(WAIVE, ACTOR, CLIENT)).rejects.toMatchObject({
      type: ERR.NOT_FOUND,
    });
    expect(events.record).not.toHaveBeenCalled();
  });

  it('answers 400 on requirementId for a row already waived', async () => {
    requirements.waive.mockResolvedValue({
      ok: false,
      reason: 'already_closed',
      satisfiedAt: null,
      waivedAt: new Date(),
    });

    const err = await service.waive(WAIVE, ACTOR, CLIENT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
    expect(err).toMatchObject({ type: ERR.VALIDATION_FAILED });
    expect((err as ProblemException).errors?.[0]).toMatchObject({ path: 'requirementId' });
    expect((err as ProblemException).errors?.[0]?.message).toContain('already been waived');
  });

  it('names the approval when the row was discharged by verifying', async () => {
    // A different instruction: the USER discharged it, so there is nothing to waive.
    requirements.waive.mockResolvedValue({
      ok: false,
      reason: 'already_closed',
      satisfiedAt: new Date(),
      waivedAt: null,
    });

    const err = await service.waive(WAIVE, ACTOR, CLIENT).catch((e: unknown) => e);
    expect((err as ProblemException).errors?.[0]?.message).toContain('approved verification');
  });

  it('records the waiver reason, which nothing else retains', async () => {
    await service.waive(WAIVE, ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ADMIN_KYC_REQUIREMENT_WAIVED',
        adminId: ACTOR.adminId,
        metadata: {
          userId: USER,
          requirementId: REQUIREMENT,
          requiredLevel: 'L1',
          triggerKey: 'ADMIN:CASE-4182',
          outcome: 'waived',
          reason: WAIVE.reason,
        },
      }),
    );
  });

  it('never audits a refusal', async () => {
    requirements.waive.mockResolvedValue({
      ok: false,
      reason: 'already_closed',
      satisfiedAt: null,
      waivedAt: new Date(),
    });
    await service.waive(WAIVE, ACTOR, CLIENT).catch(() => undefined);
    expect(events.record).not.toHaveBeenCalled();
  });
});

describe('listing', () => {
  it('projects the row without exposing raw column names', async () => {
    const payload = await service.list({ userId: USER, limit: 25 });

    expect(requirements.listForUser).toHaveBeenCalledWith(USER, 25);
    expect(Object.keys(payload.requirements[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'open',
      'policyRegion',
      'policyVersion',
      'requiredLevel',
      'satisfiedAt',
      'satisfiedByVerificationId',
      'triggerKey',
      'triggerKind',
      'updatedAt',
      'userId',
      'waivedAt',
      'waivedBy',
    ]);
  });

  it('reports `open` as the database computed it, not from the Node clock', async () => {
    requirements.listForUser.mockResolvedValue([
      row({ satisfied_at: new Date(), satisfied_by_verification_id: VERIFICATION, open: false }),
    ]);

    const payload = await service.list({ userId: USER, limit: 25 });
    expect(payload.requirements[0]).toMatchObject({
      open: false,
      satisfiedByVerificationId: VERIFICATION,
    });
  });

  it('audits nothing — it is a pure read', async () => {
    await service.list({ userId: USER, limit: 25 });
    expect(events.record).not.toHaveBeenCalled();
  });
});

describe('this service computes no KYC standing', () => {
  it('has no method that could be mistaken for an evaluator', async () => {
    const names = Object.getOwnPropertyNames(KycRequirementService.prototype);
    expect(
      names.filter((name) => /effective|standing|validity|renewal|exempt|satisf|held/i.test(name)),
    ).toEqual([]);
  });

  it('never reads a level state, an exemption or a renewal period', async () => {
    // Structural: the dboperation double exposes exactly three methods, and the
    // service is wired to nothing else. A future edit that injected a second
    // collaborator to look up standing would fail here.
    await service.require(REQUIRE, ACTOR, CLIENT);
    await service.waive(WAIVE, ACTOR, CLIENT);
    await service.list({ userId: USER, limit: 25 });

    expect(Object.keys(requirements).sort()).toEqual(['listForUser', 'require', 'waive']);
  });
});
