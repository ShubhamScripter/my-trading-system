import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { KycExemptionService } from '../../src/kyc/kyc-exemption.service';
import { makePrincipal } from '../harness';

/**
 * The exemption service against doubles.
 *
 * An exemption is the most consequential write in this module: the consumer folds a
 * live one into `effectiveLevel` on every evaluation, so a grant raises an account's
 * standing platform-wide with nothing attesting anything. What is proved here is that
 * each refusal becomes the RIGHT answer — in particular that a duplicate grant is a
 * 409 rather than a silent replacement, and that a row belonging to somebody else is
 * indistinguishable from one that does not exist.
 */

const ACTOR = makePrincipal({ adminId: '0195f0a0-aaaa-7000-8000-000000000001' });
const CLIENT = { ip: '203.0.113.10', userAgent: 'vitest', acceptLanguage: 'en' } as never;
const USER = '0195f0a0-bbbb-7000-8000-000000000002';
const EXEMPTION = '0195f0a0-cccc-7000-8000-000000000003';

const GRANT = {
  action: 'grant' as const,
  userId: USER,
  effectiveLevel: 'L1',
  reason: 'Sanctioned onboarding exception, ticket OPS-4182.',
  expiresAt: null,
};

const REVOKE = {
  action: 'revoke' as const,
  userId: USER,
  exemptionId: EXEMPTION,
  reason: 'Exception withdrawn.',
};

let exemptions: {
  listForUser: ReturnType<typeof vi.fn>;
  listLive: ReturnType<typeof vi.fn>;
  grant: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
};
let events: { record: ReturnType<typeof vi.fn> };
let service: KycExemptionService;

beforeEach(() => {
  exemptions = {
    listForUser: vi.fn().mockResolvedValue([]),
    listLive: vi.fn().mockResolvedValue([]),
    grant: vi.fn().mockResolvedValue({ ok: true, id: EXEMPTION, supersededExpired: false }),
    revoke: vi.fn().mockResolvedValue({ ok: true }),
  };
  events = { record: vi.fn().mockResolvedValue(undefined) };
  service = new KycExemptionService(exemptions as never, events as never);
});

describe('listing', () => {
  it('lists one account when a filter is given', async () => {
    await service.list({ userId: USER, limit: 25 });

    expect(exemptions.listForUser).toHaveBeenCalledWith(USER, 25);
    expect(exemptions.listLive).not.toHaveBeenCalled();
  });

  it('lists everyone currently holding relief when no filter is given', async () => {
    // The compliance-review question, and unanswerable without it. Bounded by the
    // partial unique index, which permits one live row per account.
    await service.list({ limit: 25 });

    expect(exemptions.listLive).toHaveBeenCalledWith(25);
    expect(exemptions.listForUser).not.toHaveBeenCalled();
  });
});

describe('granting', () => {
  it('grants and records an audit event naming the subject', async () => {
    await service.grant(GRANT, ACTOR, CLIENT);

    expect(exemptions.grant).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, effectiveLevel: 'L1', actorAdminId: ACTOR.adminId }),
    );
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ADMIN_KYC_EXEMPTION_GRANTED',
        // The ACTOR, never the subject — the subject is in metadata.
        adminId: ACTOR.adminId,
        metadata: expect.objectContaining({ userId: USER, exemptionId: EXEMPTION }),
      }),
    );
  });

  it('keeps the audit metadata to flat scalars', async () => {
    await service.grant(GRANT, ACTOR, CLIENT);

    const { metadata } = events.record.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    for (const value of Object.values(metadata)) {
      expect(['string', 'number', 'boolean', 'object']).toContain(typeof value);
      if (typeof value === 'object') expect(value).toBeNull();
    }
  });

  it('refuses a duplicate live grant with 409 rather than replacing it', async () => {
    // An implicit revoke-and-replace would hide which grant was in force at a given
    // moment, which is the one thing this table exists to record.
    exemptions.grant.mockResolvedValue({ ok: false, reason: 'already_exempt' });

    const failure = await service.grant(GRANT, ACTOR, CLIENT).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ProblemException);
    expect((failure as ProblemException).type).toBe(ERR.KYC_EXEMPTION_ACTIVE);
    expect((failure as ProblemException).detail).toContain('Revoke it first');
  });

  it('answers 404 for an unknown account rather than a foreign-key 500', async () => {
    exemptions.grant.mockResolvedValue({ ok: false, reason: 'unknown_user' });

    const failure = await service.grant(GRANT, ACTOR, CLIENT).catch((err: unknown) => err);

    expect((failure as ProblemException).type).toBe(ERR.NOT_FOUND);
  });

  it('records no audit event when the grant was refused', async () => {
    exemptions.grant.mockResolvedValue({ ok: false, reason: 'already_exempt' });

    await service.grant(GRANT, ACTOR, CLIENT).catch(() => undefined);

    expect(events.record).not.toHaveBeenCalled();
  });

  /**
   * The expired-slot trap.
   *
   * `ux_kyc_exemptions_live` keys only on `revoked_at IS NULL`, while the consumer
   * additionally requires `expires_at > now`. So a lapsed-but-unrevoked row occupies
   * the account's one slot while granting nothing. The persistence layer closes it;
   * the service reports that it happened, so the audit trail shows the replacement was
   * not a silent overwrite of something live.
   */
  it('reports when a lapsed exemption was closed to make room', async () => {
    exemptions.grant.mockResolvedValue({ ok: true, id: EXEMPTION, supersededExpired: true });

    await service.grant(GRANT, ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ supersededExpired: true }) }),
    );
  });

  it('carries the expiry into the audit row, so permanence is on the record', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await service.grant({ ...GRANT, expiresAt }, ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ expiresAt }) }),
    );
  });
});

describe('revoking', () => {
  it('revokes and records an audit event', async () => {
    await service.revoke(REVOKE, ACTOR, CLIENT);

    expect(exemptions.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, exemptionId: EXEMPTION }),
    );
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ADMIN_KYC_EXEMPTION_REVOKED' }),
    );
  });

  it('answers 404 for an unknown exemption', async () => {
    exemptions.revoke.mockResolvedValue({ ok: false, reason: 'not_found' });

    const failure = await service.revoke(REVOKE, ACTOR, CLIENT).catch((err: unknown) => err);

    expect((failure as ProblemException).type).toBe(ERR.NOT_FOUND);
  });

  it('reports an already-revoked row as a stale payload, not a missing one', async () => {
    const revokedAt = new Date('2026-09-01T00:00:00.000Z');
    exemptions.revoke.mockResolvedValue({ ok: false, reason: 'already_revoked', revokedAt });

    const failure = await service.revoke(REVOKE, ACTOR, CLIENT).catch((err: unknown) => err);

    expect((failure as ProblemException).type).toBe(ERR.VALIDATION_FAILED);
    expect((failure as ProblemException).errors?.[0]?.path).toBe('exemptionId');
    expect((failure as ProblemException).errors?.[0]?.message).toContain('2026-09-01');
  });

  it('records no audit event when the revoke was refused', async () => {
    exemptions.revoke.mockResolvedValue({ ok: false, reason: 'not_found' });

    await service.revoke(REVOKE, ACTOR, CLIENT).catch(() => undefined);

    expect(events.record).not.toHaveBeenCalled();
  });
});
