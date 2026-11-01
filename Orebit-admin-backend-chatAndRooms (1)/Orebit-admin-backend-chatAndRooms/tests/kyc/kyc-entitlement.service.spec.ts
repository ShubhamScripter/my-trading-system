import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_EVENT } from '../../auth/auth.dboperation';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { clientContextOf } from '../../auth/auth.utility';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { KycEntitlementService } from '../../src/kyc/kyc-entitlement.service';
import { kycEntitlementRequestSchema } from '../../src/kyc/kyc-entitlement.dto';
import { VALID_ENTITLEMENTS, VALID_UPGRADE } from './kyc.cases';

/**
 * ═══ WHAT A WRITE STORES, AND WHAT IT RECORDS ═══════════════════════════════
 *
 * `KycEntitlementDbOperation` is doubled. What this file owns is everything between the
 * parsed body and that call:
 *
 *   the nested DTO shape flattened onto the right columns
 *   the compare-and-swap refusal, and the two different reasons for it
 *   the audit event, which on this surface is the ONLY configuration history
 *
 * ⚠ WHAT IS NOT COVERED HERE OR ANYWHERE YET: the SQL itself, against a real database.
 *   `kyc.postgres.spec.ts` does that for the requirement writer, and the equivalent for
 *   these two tables cannot run until `orebit_test` has the entitlements migration —
 *   that database currently holds `identity.kyc_requirements` but not
 *   `kyc_level_entitlements`, `kyc_upgrade_requirements` or `kyc_renewal_settings`. So
 *   the seventy-one-column UPDATE and the compare-and-swap predicate are proved by
 *   inspection and by the drift spec's column check, NOT by execution. The structural
 *   suite at the foot of this file is what covers the property that matters most in the
 *   meantime — which tables the writer can reach at all.
 *
 * ─── Bodies go through the real schema first ───────────────────────────────
 *
 * Every input below is `kycEntitlementRequestSchema.parse(...)`, not a hand-built
 * object. The service takes the PARSED type, and a hand-built literal would let a test
 * pass a shape the boundary would have refused — which is how a flattening bug survives
 * its own test.
 */

const ACTOR: Principal = {
  adminId: '0195f0a0-aaaa-7000-8000-000000000001',
  sessionId: '0195f0a0-dddd-7000-8000-000000000004',
  role: 'SUPER_ADMIN',
  familyId: '0195f0a0-eeee-7000-8000-000000000005',
} as Principal;

// Built through the real helper rather than a literal, so the shape cannot drift from
// what the routes actually hand the service.
const CLIENT: ClientContext = clientContextOf('203.0.113.9', 'test-agent', 'en');

const db = {
  listEntitlements: vi.fn(),
  listUpgradeRequirements: vi.fn(),
  findEntitlementVersion: vi.fn(),
  findUpgradeVersion: vi.fn(),
  achievementImpact: vi.fn(),
  writeEntitlements: vi.fn(),
  writeUpgradeRequirement: vi.fn(),
};

const events = { record: vi.fn() };

function service(): KycEntitlementService {
  return new KycEntitlementService(db as never, events as never);
}

/** One stored row, enough for the projection to be asserted. */
function row(level: string, overrides: Record<string, unknown> = {}) {
  return {
    level,
    configured: true,
    version: 3,
    withdrawal_limit: '1000',
    exchange_limit: null,
    balance_limit: null,
    limit_currency: 'USDT',
    profile_links_enabled: true,
    wallet_disabled_currencies: ['XMR'],
    deposit_on_ramp_enabled: true,
    deposit_off_ramp_enabled: false,
    withdraw_enabled: true,
    withdraw_max_per_transaction: null,
    withdraw_amount_limit: null,
    withdraw_count_limit: null,
    withdraw_limit_window_seconds: null,
    withdraw_minimum_gap_seconds: null,
    withdraw_security_threshold: null,
    exchange_enabled: false,
    exchange_min_amount: null,
    exchange_max_amount: null,
    exchange_max_per_exchange: null,
    exchange_small_enabled: false,
    exchange_multi_coin_enabled: false,
    exchange_available_coins: ['BTC'],
    transfer_enabled: false,
    transfer_min_amount: null,
    transfer_max_amount: null,
    transfer_max_per_transfer: null,
    transfer_max_per_user: null,
    staking_enabled: true,
    staking_available_coins: ['SOL'],
    staking_flexible_enabled: true,
    staking_locked_enabled: false,
    merchant_enabled: false,
    merchant_max_websites_or_apps: null,
    tools_bulk_payment_enabled: false,
    tools_tip_box_enabled: true,
    tools_max_tip_boxes: 3,
    tools_invoice_generator_enabled: false,
    tools_max_active_invoices: null,
    referral_enabled: true,
    referral_allowed_divisions: ['NORTH'],
    referral_allowed_tiers: ['GOLD'],
    referral_max_active_links: 10,
    rainpool_eligible: true,
    rainpool_can_rain: false,
    ptc_can_view_ads: true,
    ptc_can_advertise: false,
    tasks_can_participate: true,
    tasks_can_advertise: false,
    tasks_allowed_providers: ['PROVIDER_A'],
    premium_can_purchase: true,
    premium_can_gift: false,
    short_link_enabled: false,
    advertising_enabled: false,
    coupons_can_create: false,
    coupons_can_redeem: true,
    coupons_can_purchase_third_party: false,
    loyalty_enabled: true,
    chat_can_access_public_chat: true,
    chat_can_advertise: false,
    chat_can_send_money: false,
    chat_allowed_rooms: [],
    ad_exchange_enabled: false,
    leaderboard_can_receive_rewards: true,
    faucet_enabled: true,
    faucet_auto_enabled: false,
    faucet_offline_enabled: false,
    bankroll_enabled: false,
    bankroll_max_investment: null,
    updated_by_admin_id: ACTOR.adminId,
    reason: 'because',
    updated_at: new Date('2026-09-18T09:00:00.000Z'),
    ...overrides,
  };
}

function parseEntitlements(overrides: Record<string, unknown> = {}) {
  const parsed = kycEntitlementRequestSchema.parse({ ...VALID_ENTITLEMENTS, ...overrides });
  if (parsed.action !== 'entitlements') throw new Error('wrong action');
  return parsed;
}

function parseUpgrade(overrides: Record<string, unknown> = {}) {
  const parsed = kycEntitlementRequestSchema.parse({ ...VALID_UPGRADE, ...overrides });
  if (parsed.action !== 'upgrade') throw new Error('wrong action');
  return parsed;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.listEntitlements.mockResolvedValue([row('NONE'), row('L1'), row('L2')]);
  db.listUpgradeRequirements.mockResolvedValue([]);
  db.findEntitlementVersion.mockResolvedValue(1);
  db.findUpgradeVersion.mockResolvedValue(null);
  db.achievementImpact.mockResolvedValue({ accountsAlreadyAchieved: 0 });
  db.writeEntitlements.mockResolvedValue({ written: true });
  db.writeUpgradeRequirement.mockResolvedValue({ written: true });
  events.record.mockResolvedValue(undefined);
});

describe('reading the configuration', () => {
  it('returns every level plus the vocabularies a form needs', async () => {
    const payload = await service().read();

    expect(payload.entitlements.map((entry) => entry.level)).toEqual(['NONE', 'L1', 'L2']);
    expect(payload.levels).toEqual(['NONE', 'L1', 'L2']);
    expect(payload.targetLevels).toEqual(['L1', 'L2']);
    // Spelled out rather than left to a client to infer — the convention
    // `GET /kyc-policies` already publishes.
    expect(payload.versionToCreate).toBe(0);
  });

  it('audits nothing — it returns rules, not personal data', async () => {
    await service().read();
    // The audited read on this module is KYC HISTORY, because that one returns provider
    // decisions about a person.
    expect(events.record).not.toHaveBeenCalled();
  });

  it('projects a stored row into the shape POST accepts', async () => {
    const payload = await service().read();
    const l1 = payload.entitlements.find((entry) => entry.level === 'L1');

    expect(l1?.limits).toEqual({
      currency: 'USDT',
      withdrawal: '1000',
      exchange: null,
      balance: null,
    });
    // The one renamed field across the boundary: `chat_can_advertise` becomes
    // `canAdvertiseInChat`.
    expect(l1?.features.chat.canAdvertiseInChat).toBe(false);
    expect(l1?.features.staking.types).toEqual({ flexible: true, locked: false });
    expect(l1?.features.tools.tipBox).toEqual({ enabled: true, maxTipBoxes: 3 });
    expect(l1?.updatedAt).toBe('2026-09-18T09:00:00.000Z');
  });

  it('refuses rather than reporting an empty matrix when the table is unseeded', async () => {
    // An empty matrix and an unmigrated database look identical to a screen. Rendering
    // "no levels configured" would have an operator configure nothing and wonder why.
    db.listEntitlements.mockResolvedValue([]);
    await expect(service().read()).rejects.toThrow();
  });
});

describe('writing one level’s entitlements', () => {
  it('flattens the nested body onto the right columns', async () => {
    await service().writeEntitlements(parseEntitlements(), ACTOR, CLIENT);

    expect(db.writeEntitlements).toHaveBeenCalledTimes(1);
    const call = db.writeEntitlements.mock.calls[0]?.[0] as {
      level: string;
      expectedVersion: number;
      actorAdminId: string;
      values: Record<string, unknown>;
    };

    expect(call.level).toBe('L1');
    expect(call.expectedVersion).toBe(1);
    expect(call.actorAdminId).toBe(ACTOR.adminId);

    // A spot-check across five groups, chosen so a crossed wire in any of them fails:
    // one limit, one amount, one count, one list, and the two renamed fields.
    expect(call.values.withdrawalLimit).toBe('1000');
    expect(call.values.withdrawMaxPerTransaction).toBe('500');
    expect(call.values.toolsMaxTipBoxes).toBe(3);
    expect(call.values.exchangeAvailableCoins).toEqual(['BTC', 'ETH']);
    // `types.flexible` -> `stakingFlexibleEnabled`
    expect(call.values.stakingFlexibleEnabled).toBe(true);
    expect(call.values.stakingLockedEnabled).toBe(false);
    // `chat.canAdvertiseInChat` -> `chatCanAdvertise`
    expect(call.values.chatCanAdvertise).toBe(false);
    // `transfer.maxTransferPerUser` -> `transferMaxPerUser`
    expect(call.values.transferMaxPerUser).toBe('200');
  });

  it('records the WHOLE configuration on the audit event', async () => {
    await service().writeEntitlements(parseEntitlements(), ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledTimes(1);
    const event = events.record.mock.calls[0]?.[0] as {
      eventType: string;
      adminId: string;
      metadata: Record<string, unknown>;
    };

    expect(event.eventType).toBe(AUTH_EVENT.KYC_ENTITLEMENTS_UPDATED);
    expect(event.adminId).toBe(ACTOR.adminId);
    expect(event.metadata.level).toBe('L1');
    expect(event.metadata.version).toBe(2);
    expect(event.metadata.reason).toBe(VALID_ENTITLEMENTS.reason);

    // ⚠ This event IS the history — neither table has a versions table behind it. A
    // payload carrying only the level and version would make "what could an L1 account
    // do in March" unanswerable.
    const limits = JSON.parse(event.metadata.limits as string) as Record<string, unknown>;
    const features = JSON.parse(event.metadata.features as string) as Record<string, never>;
    expect(limits.withdrawal).toBe('1000');
    expect(
      (features.withdraw as unknown as Record<string, unknown>).maxPerTransaction,
    ).toBe('500');
  });

  it('commits BEFORE it audits, so a failed audit cannot lose the write', async () => {
    const order: string[] = [];
    db.writeEntitlements.mockImplementation(async () => {
      order.push('write');
      return { written: true };
    });
    events.record.mockImplementation(async () => {
      order.push('audit');
    });

    await service().writeEntitlements(parseEntitlements(), ACTOR, CLIENT);

    // `AuthEventDbOperation.record` swallows its own failures by design, so the database
    // write is authoritative and the event is observability.
    expect(order).toEqual(['write', 'audit']);
  });

  it('returns the re-read configuration rather than echoing the request', async () => {
    const payload = await service().writeEntitlements(parseEntitlements(), ACTOR, CLIENT);

    // A screen reads, edits, writes and re-renders from one response. Echoing the
    // request would hide a value the database normalised or a concurrent change.
    expect(db.listEntitlements).toHaveBeenCalled();
    expect(payload.entitlements).toHaveLength(3);
  });
});

describe('the compare-and-swap refusal', () => {
  it('refuses a stale version and names the live one', async () => {
    db.writeEntitlements.mockResolvedValue({ written: false });
    db.findEntitlementVersion.mockResolvedValue(7);

    // A 400 on the version field rather than a 409: nothing about waiting changes the
    // answer, and the remedy is to re-read. `KycPolicyService` draws the line the same
    // way.
    const failure = await refusalOf(() =>
      service().writeEntitlements(parseEntitlements(), ACTOR, CLIENT),
    );
    expect(failure.type).toBe(ERR.VALIDATION_FAILED);
    expect(failure.errors?.[0]?.path).toBe('expectedVersion');
    expect(failure.errors?.[0]?.message).toContain('7');
  });

  it('distinguishes a MISSING row from a lost swap', async () => {
    // The two are indistinguishable from the UPDATE's result and need different
    // messages: one says re-read, the other says this environment has not migrated.
    db.writeEntitlements.mockResolvedValue({ written: false });
    db.findEntitlementVersion.mockResolvedValue(null);

    const failure = await refusalOf(() =>
      service().writeEntitlements(parseEntitlements(), ACTOR, CLIENT),
    );
    expect(failure.errors?.[0]?.path).toBe('level');
    expect(failure.errors?.[0]?.message).toContain('migration');
  });

  it('audits nothing when the write was refused', async () => {
    db.writeEntitlements.mockResolvedValue({ written: false });

    await expect(
      service().writeEntitlements(parseEntitlements(), ACTOR, CLIENT),
    ).rejects.toThrow();

    // An audit row for a change that did not happen is worse than no row.
    expect(events.record).not.toHaveBeenCalled();
  });
});

describe('writing one target’s upgrade routes', () => {
  it('passes the thresholds and the window through unchanged', async () => {
    await service().writeUpgradeRequirement(parseUpgrade(), ACTOR, CLIENT);

    expect(db.writeUpgradeRequirement).toHaveBeenCalledWith({
      targetLevel: 'L2',
      minimumBalance: '10000',
      depositThreshold: '20000',
      // DAYS here. The conversion to seconds happens in the consumer, at the single
      // point the figure reaches the account-data port.
      depositWindowDays: 30,
      thresholdCurrency: 'USDT',
      reason: VALID_UPGRADE.reason,
      actorAdminId: ACTOR.adminId,
      expectedVersion: 0,
    });
  });

  it('measures the already-achieved population BEFORE the write', async () => {
    const order: string[] = [];
    db.achievementImpact.mockImplementation(async () => {
      order.push('count');
      return { accountsAlreadyAchieved: 42 };
    });
    db.writeUpgradeRequirement.mockImplementation(async () => {
      order.push('write');
      return { written: true };
    });

    await service().writeUpgradeRequirement(parseUpgrade(), ACTOR, CLIENT);

    expect(order).toEqual(['count', 'write']);
    const event = events.record.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    // ⚠ NOT a blast radius. Those accounts are precisely the ones this change cannot
    // affect: an achievement is permanent, so raising a threshold revokes none and
    // lowering one creates none.
    expect(event.metadata.accountsAlreadyAchieved).toBe(42);
  });

  it('records version 1 on a create', async () => {
    await service().writeUpgradeRequirement(parseUpgrade({ expectedVersion: 0 }), ACTOR, CLIENT);

    const event = events.record.mock.calls[0]?.[0] as {
      eventType: string;
      metadata: Record<string, unknown>;
    };
    expect(event.eventType).toBe(AUTH_EVENT.KYC_UPGRADE_REQUIREMENTS_UPDATED);
    expect(event.metadata.version).toBe(1);
  });

  it('tells a create that lost a race to re-read', async () => {
    db.writeUpgradeRequirement.mockResolvedValue({ written: false });
    db.findUpgradeVersion.mockResolvedValue(1);

    const failure = await refusalOf(() =>
      service().writeUpgradeRequirement(parseUpgrade({ expectedVersion: 0 }), ACTOR, CLIENT),
    );
    expect(failure.errors?.[0]?.path).toBe('expectedVersion');
  });

  it('tells an update of an absent row to create it instead', async () => {
    db.writeUpgradeRequirement.mockResolvedValue({ written: false });
    db.findUpgradeVersion.mockResolvedValue(null);

    const failure = await refusalOf(() =>
      service().writeUpgradeRequirement(parseUpgrade({ expectedVersion: 4 }), ACTOR, CLIENT),
    );
    expect(failure.errors?.[0]?.path).toBe('targetLevel');
    expect(failure.errors?.[0]?.message).toContain('expectedVersion: 0');
  });

  it('accepts withdrawing both routes', async () => {
    await service().writeUpgradeRequirement(
      parseUpgrade({
        minimumBalance: null,
        depositThreshold: null,
        depositWindowDays: null,
        thresholdCurrency: null,
      }),
      ACTOR,
      CLIENT,
    );

    expect(db.writeUpgradeRequirement).toHaveBeenCalledWith(
      expect.objectContaining({ minimumBalance: null, depositThreshold: null }),
    );
  });
});

describe('this service never touches a credential or an achievement', () => {
  it('has no method that could write one', () => {
    // A structural assertion, matching the one `kyc.postgres.spec.ts` makes over the SQL
    // layer. What an account has PROVED arrives over a signed webhook in the consumer,
    // and an achievement is an observation of a balance only the consumer can make.
    const names = Object.getOwnPropertyNames(KycEntitlementService.prototype).filter(
      (name) => name !== 'constructor',
    );
    //  is private by convention;  sees it anyway.
    expect(names.sort()).toEqual([
      'read',
      'refuseLostSwap',
      'writeEntitlements',
      'writeUpgradeRequirement',
    ]);
  });

  it('reads the achievement count but never writes one', async () => {
    await service().writeUpgradeRequirement(parseUpgrade(), ACTOR, CLIENT);

    // `achievementImpact` is a count. There is no corresponding writer on the
    // dboperation at all, which is what makes "an admin cannot grant an upgrade route
    // nobody earned" structural rather than careful.
    expect(db.achievementImpact).toHaveBeenCalledWith('L2');
    expect(Object.keys(db)).not.toContain('recordAchievement');
  });
});

/**
 * The  a call rejected with.
 *
 * The idiom  uses:  cannot see the
 * fields, because a  carries  and  directly on the
 * Error rather than under a wrapper.
 */
async function refusalOf(call: () => Promise<unknown>): Promise<ProblemException> {
  try {
    await call();
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to be refused');
}

describe('the entitlement writer touches two tables and no others', () => {
  /**
   * ═══ THE CREDENTIAL BOUNDARY, ASSERTED STRUCTURALLY ══════════════════════
   *
   * The whole justification for letting Admin configure what a level GRANTS is that it
   * cannot manufacture standing. That holds only while this writer names no other
   * table, so it is checked rather than trusted — the same technique
   * `kyc.postgres.spec.ts` uses for the requirement writer, and deliberately a SOURCE
   * check so it runs without a database.
   *
   * ⚠ `kyc_upgrade_achievements` appears in a SELECT and must never appear in anything
   *   else. An achievement is an observation of a balance; only the consumer holds the
   *   port that can make one. An admin able to grant one could open an upgrade route
   *   nobody earned, with no reason, no expiry and no revocation path.
   */
  const source = readFileSync(
    join(__dirname, '..', '..', 'src', 'kyc', 'kyc-entitlement.dboperation.ts'),
    'utf8',
  );

  /** Comments stripped, so the file's own prose about what it does NOT touch cannot
   *  fail an assertion about what it does. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');

  it('mutates only the two configuration tables', () => {
    const mutations = [
      ...code.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+"identity"\."(\w+)"/g),
    ].map((match) => match[2] as string);

    expect(mutations.length).toBeGreaterThan(0);
    expect([...new Set(mutations)].sort()).toEqual([
      'kyc_level_entitlements',
      'kyc_upgrade_requirements',
    ]);
  });

  it('never mutates the achievement table, though it reads a count from it', () => {
    // The read is expected and narrow.
    expect(code).toContain('FROM "identity"."kyc_upgrade_achievements"');

    for (const verb of ['INSERT INTO', 'UPDATE', 'DELETE FROM']) {
      expect(
        code,
        `${verb} against kyc_upgrade_achievements would let an admin grant an upgrade route nobody earned`,
      ).not.toContain(`${verb} "identity"."kyc_upgrade_achievements"`);
    }
  });

  it('names no credential, obligation or policy table at all', () => {
    for (const forbidden of [
      'kyc_verifications',
      'kyc_level_states',
      'kyc_verification_devices',
      'kyc_provider_events',
      'kyc_requirements',
      'kyc_exemptions',
      'kyc_policies',
      'kyc_policy_versions',
      'kyc_renewal_settings',
      'users',
    ]) {
      expect(code, `must not touch ${forbidden}`).not.toContain(`"${forbidden}"`);
    }
  });

  it('clamps every interpolated LIMIT, or interpolates none', () => {
    // `Prisma.raw` is the only path to SQL injection in this layer. This writer happens
    // to interpolate nothing — every value is a bind parameter — and this asserts that
    // rather than leaving it to be re-checked by eye after the next edit.
    expect(code).not.toContain('Prisma.raw');
  });
});
