import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_TRIGGER_KIND,
  KYC_GLOBAL_REGION,
  KYC_ENTITLEMENT_LEVELS,
  KYC_POLICY_LEVELS,
  KYC_TRIGGER_KINDS,
  KYC_TRIGGER_SEGMENT,
  ROLLING_WINDOW_OPERATIONS,
  adminTriggerKey,
  enforcementRejectionOf,
} from '../../src/kyc/kyc.types';
import { CONSTRAINT_CASES } from './kyc.cases';

/**
 * ═══ THE COPY THAT A SHARED IMPORT WOULD HAVE CHECKED FOR FREE ═════════════
 *
 * `src/kyc/` duplicates vocabularies, column names and four validation rules that also
 * live in `../Orebit-backend`. There is no shared package between the two services —
 * no workspace, no monorepo — and every other shared thing in this platform is copied
 * the same way. `security-policies.drift.spec.ts` is the precedent for this file.
 *
 * The duplication is only safe because of these assertions. The values are STORED: an
 * admin writes `L2` and `WITHDRAWAL` into `identity.kyc_policies`, and the consumer
 * matches on them. If the lists drift, TypeScript says nothing in either repository —
 * the symptom is a policy an operator configured that the enforcer silently discards.
 *
 * ─── Why it reads the files as TEXT ────────────────────────────────────────
 *
 * Importing across the repository boundary would make this service's build depend on
 * the other service's TypeScript, which is exactly the coupling the copy exists to
 * avoid. Reading the source and extracting the literals asserts agreement without
 * creating a build edge.
 *
 * ─── Why it SKIPS when the sibling is absent ───────────────────────────────
 *
 * This service must build and test on its own — in CI, in a container, from a clone
 * that does not have the consumer beside it. A missing sibling is a fact about the
 * checkout rather than a drift, so it is reported and skipped.
 */

const CONSUMER = join(__dirname, '..', '..', '..', 'Orebit-backend');
const CONSTANTS = join(CONSUMER, 'src', 'kyc', 'kyc.constants.ts');
const POLICY = join(CONSUMER, 'src', 'kyc', 'kyc.policy.ts');
const SCHEMA = join(CONSUMER, 'db', 'schema.prisma');
const IDENTITY_SQL = join(CONSUMER, 'db', 'sql', 'identity.sql');
/** Where `buildTriggerKey` and `TRIGGER_SEGMENT` live — the grammar this service has
 *  to reproduce byte-for-byte to write an `ADMIN:<REFERENCE>` row. */
const UTILITY = join(CONSUMER, 'src', 'kyc', 'kyc.utility.ts');

const present = [CONSTANTS, POLICY, SCHEMA, IDENTITY_SQL, UTILITY].every((path) =>
  existsSync(path),
);

if (!present) {
  // eslint-disable-next-line no-console
  console.warn(`[kyc drift] ${CONSUMER} not found — cross-repository checks SKIP.`);
}

const read = (path: string): string => (present ? readFileSync(path, 'utf8') : '');

/** The members of an `as const` string tuple, by its declared name. */
function tupleOf(source: string, name: string): string[] {
  const declaration = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(source);
  if (declaration === null) return [];
  return [...declaration[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe.skipIf(!present)('the vocabularies match the consumer', () => {
  it('requestable levels are the levels a policy may demand', () => {
    expect(tupleOf(read(CONSTANTS), 'REQUESTABLE_KYC_LEVELS')).toEqual([...KYC_POLICY_LEVELS]);
  });

  it('rolling-window operations match', () => {
    expect(tupleOf(read(CONSTANTS), 'ROLLING_WINDOW_OPERATIONS')).toEqual([
      ...ROLLING_WINDOW_OPERATIONS,
    ]);
  });

  it('the global region sentinel matches', () => {
    const declared = /KYC_GLOBAL_REGION\s*=\s*'([^']+)'/.exec(read(CONSTANTS));
    expect(declared?.[1]).toBe(KYC_GLOBAL_REGION);
  });
});

describe.skipIf(!present)('every column this service writes still exists', () => {
  /**
   * The columns the writer names, as `@map`ped in the consumer's schema.
   *
   * This is the check that catches the failure mode the dboperation's header warns
   * about: a column renamed over there breaks this writer at RUNTIME, and nothing in
   * either type system says so. `sub_features` is the one most worth pinning — the
   * neighbouring `security_restriction_policies` table spells its equivalent
   * `subFeatures`, so the two are genuinely different and easy to confuse.
   */
  const WRITTEN_COLUMNS = [
    'region',
    'level',
    'enabled',
    'required',
    'triggers_only',
    'workflow_id',
    'renewal_workflow_id',
    'balance_threshold',
    'lifetime_deposit_threshold',
    'lifetime_withdrawal_threshold',
    'rolling_window_amount',
    'rolling_window_seconds',
    'rolling_window_operation',
    'threshold_currency',
    'features',
    'sub_features',
    'version',
    'updated_by_admin_id',
    'reason',
  ];

  const schema = read(SCHEMA);

  /** One `model X { ... }` block, so a field assertion cannot be satisfied by an
   *  identically named field on some other model — `version` and `reason` are on half
   *  of them. */
  const modelBlock = (name: string): string => {
    // `[{]` and `[}]` rather than `\{` and `\}`: the braces need no escaping in a
    // regex, and inside a template literal a single backslash would be swallowed
    // before `RegExp` ever saw it — `\s` would arrive as a bare `s`.
    const match = schema.match(new RegExp(`^model ${name} [{]([^]*?)^[}]`, 'm'));
    if (match === null) throw new Error(`no model ${name} in the consumer schema`);
    return match[1] as string;
  };

  it.each(WRITTEN_COLUMNS)('kyc_policies has "%s"', (column) => {
    // `features` and `region` and friends have no @map because the Prisma field name
    // already matches, so accept either spelling.
    const mapped = schema.includes(`@map("${column}")`);
    const bare = new RegExp(`^\\s*${column}\\s`, 'm').test(schema);
    expect(mapped || bare, `neither @map("${column}") nor a bare field found`).toBe(true);
  });

  /**
   * ═══ THE RENEWAL PERIODS ARE GONE FROM THE POLICY TABLES ═════════════════
   *
   * `renewal_enabled`, `renewal_period_seconds` and `grace_period_seconds` were dropped
   * once the renewal engine shipped: X and Y are GLOBAL, and this table is keyed
   * `(region, level)`, so keeping them meant one platform-wide number stored on two rows
   * per country that could disagree.
   *
   * Asserted as ABSENT rather than simply not asserted, because the failure this guards
   * is a reintroduction — someone adding a per-region renewal period back, and the two
   * engines then silently disagreeing about when a credential expires. The global
   * settings are the only authority.
   */
  it.each(['renewal_enabled', 'renewal_period_seconds', 'grace_period_seconds'])(
    'kyc_policies no longer has "%s"',
    (column) => {
      expect(modelBlock('KycPolicy'), `${column} came back`).not.toContain(`@map("${column}")`);
      expect(modelBlock('KycPolicyVersion'), `${column} came back`).not.toContain(`@map("${column}")`);
    },
  );

  it('the CHECKs that guarded them are gone too', () => {
    // The DO-block in identity.sql only ever ADDS a constraint, so a leftover spec here
    // would try to recreate a CHECK against a column that no longer exists and fail
    // every deploy.
    const sql = read(IDENTITY_SQL);
    expect(sql).not.toContain('ck_kyc_policies_renewal');
    expect(sql).not.toContain('ck_kyc_policies_grace');
  });

  it('renewal_workflow_id SURVIVED — it is an override, not a period', () => {
    // Deliberately kept. Which Didit workflow a renewal runs is genuinely per region and
    // level; how long a credential lasts is not. It sits beside `workflow_id`, equally
    // unread today and equally retained.
    expect(modelBlock('KycPolicy')).toContain('@map("renewal_workflow_id")');
    expect(modelBlock('KycPolicyVersion')).toContain('@map("renewal_workflow_id")');
  });

  it('the global renewal periods still live on their own singleton', () => {
    // The other half of the move: dropping the per-policy columns is only correct
    // because these exist.
    const settings = modelBlock('KycRenewalSettings');
    expect(settings).toContain('@map("mandatory_period_seconds")');
    expect(settings).toContain('@map("voluntary_period_seconds")');
  });

  it('kyc_policies is still keyed on (region, level)', () => {
    expect(schema).toContain('ux_kyc_policies_target');
    expect(schema).toMatch(/@@unique\(\[region,\s*level\],\s*map:\s*"ux_kyc_policies_target"\)/);
  });

  it('kyc_policy_versions is still keyed on (region, level, version)', () => {
    expect(schema).toMatch(
      /@@unique\(\[region,\s*level,\s*version\],\s*map:\s*"ux_kyc_policy_versions_target"\)/,
    );
  });

  /**
   * ═══ THE RENEWAL SETTINGS THIS SERVICE WRITES ════════════════════════════
   *
   * `KycRenewalDbOperation` writes two columns on a table it does not own, by raw SQL,
   * against a singleton it addresses as `WHERE id = true`. Every one of those is an
   * assumption about the consumer's schema that no type system in either repository
   * checks — which is the whole reason this file exists.
   *
   * ─── Two columns, and the absences matter as much as the presences ───────
   *
   * The first cut of this feature also carried `version`, `updated_by_admin_id`,
   * `reason` and a `kyc_renewal_settings_versions` log. All four are gone, and the
   * tests below assert their ABSENCE rather than merely not mentioning them: the
   * failure worth catching is a reintroduction — somebody rebuilding a configuration
   * history in the consumer's schema that this writer would then be expected to fill.
   */
  it('kyc_renewal_settings still has the two period columns this writer sets', () => {
    // Scoped to the model BLOCK, not the whole schema: a document-wide search would
    // still pass after this table had lost them entirely.
    const block = modelBlock('KycRenewalSettings');

    for (const column of ['mandatory_period_seconds', 'voluntary_period_seconds']) {
      expect(block, `kyc_renewal_settings.${column} is gone`).toContain(`@map("${column}")`);
    }
    expect(block).toContain('@@map("kyc_renewal_settings")');
  });

  it('is exactly ONE current settings row, with no versions table beside it', () => {
    // The product requirement: a single current renewal configuration. A versions table
    // reappearing here would mean the consumer had grown a second authority for what
    // applies now, and the question "which row is live" would be back.
    expect(schema).not.toContain('kyc_renewal_settings_versions');
    expect(schema).not.toContain('model KycRenewalSettingsVersion');
    // Comments stripped: identity.sql explains in prose WHY the table is gone, and that
    // explanation must not read as the table still being declared.
    const sql = read(IDENTITY_SQL).replace(/--.*$/gm, '');
    expect(sql).not.toContain('kyc_renewal_settings_versions');
  });

  it.each(['version', 'reason', 'updated_by_admin_id'])(
    'kyc_renewal_settings no longer carries "%s"',
    (column) => {
      // Dropped by the consumer's 20260917210000_simplify_kyc_renewal_settings. Who
      // changed the periods is the admin audit log's job — duplicating it into this
      // table is what produced the history nobody asked for.
      const block = modelBlock('KycRenewalSettings');
      expect(block).not.toContain(`@map("${column}")`);
      expect(block).not.toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
    },
  );

  it('carries no renewal_enabled flag — "enabled" is derived from the periods', () => {
    // A stored boolean beside the period it describes is a second authority for one
    // fact. NULL mandatory period IS disabled, and there is nothing to disagree with.
    expect(modelBlock('KycRenewalSettings')).not.toMatch(/renewal_enabled|renewalEnabled/);
  });

  it('kyc_renewal_settings is still a BOOLEAN singleton keyed on id', () => {
    // The writer says `WHERE "id" = true` on every statement. If the key ever stops
    // being a boolean, every write silently matches nothing and the CAS reports a lost
    // race forever.
    expect(schema).toMatch(/model KycRenewalSettings \{[\s\S]*?id\s+Boolean\s+@id/);
  });

  it('the singleton CHECK that makes the boolean key mean one row still exists', () => {
    // A BOOLEAN PRIMARY KEY admits true AND false. Without this constraint the table
    // accepts a second row that no reader on either side would ever look at.
    const sql = read(IDENTITY_SQL);
    expect(sql).toContain('ck_kyc_renewal_settings_singleton');
  });

  it('the ordering CHECK the DTO mirrors still exists', () => {
    // The DTO refuses Y >= X with a field error so an operator sees which field is
    // wrong. This constraint is what stops the same mistake arriving by any other path,
    // and the DTO rule is only safe to call "defence in depth" while it is here.
    const sql = read(IDENTITY_SQL);
    expect(sql).toContain('ck_kyc_renewal_settings_ordering');
    expect(sql).toContain('ck_kyc_renewal_settings_periods');
  });

  it('has no version CHECK left over a column that no longer exists', () => {
    // The DO-block in identity.sql only ever ADDS a constraint when it is absent — it
    // never drops one. A `ck_..._version_positive` left declared there after the column
    // went would fail every `db:verify` against a migrated database.
    expect(read(IDENTITY_SQL)).not.toContain('ck_kyc_renewal_settings_version_positive');
  });

  /**
   * ═══ THE COLUMNS THE HISTORY READER PROJECTS ═════════════════════════════
   *
   * `KycHistoryDbOperation` names every one of these in raw SQL. A rename in the
   * consumer breaks the read at runtime with nothing in either repository's type system
   * objecting — and a SELECT that fails is at least loud. The dangerous direction is the
   * SEALED columns: if `document_number_ciphertext` were ever renamed to something the
   * allow-list happened to match, the surface would start returning an encrypted blob.
   */
  it('kyc_verifications still has every column the history projection selects', () => {
    const block = modelBlock('KycVerification');
    for (const column of [
      'provider_status', 'session_id', 'workflow_id', 'workflow_source',
      'verified_country', 'aml_status', 'aml_total_hits',
      'document_type', 'document_subtype',
      'started_at', 'completed_at', 'expires_at', 'renewal_of_id', 'reconciled_at',
    ]) {
      expect(block, `kyc_verifications.${column} is gone`).toContain(`@map("${column}")`);
    }
  });

  it('the sealed columns are still named what the projection excludes', () => {
    // The allow-list omits these by name. If the consumer renamed them, the omission
    // would stop matching and the next reader to widen the projection would not see
    // anything reminding them these are envelopes.
    const block = modelBlock('KycVerification');
    for (const column of [
      'document_number_ciphertext', 'document_number_iv', 'document_number_tag',
      'full_name_ciphertext', 'full_name_iv', 'full_name_tag',
    ]) {
      expect(block, `${column} was renamed`).toContain(`@map("${column}")`);
    }
  });

  it('the history listing index still exists in the consumer', () => {
    // Without it the unfiltered listing is a sequential scan plus a sort over a table
    // that only grows, and the keyset cursor stops being a seek.
    expect(schema).toMatch(/@@index\(\[createdAt\(sort: Desc\), id\(sort: Desc\)\]\)/);
  });

  it('kyc_verification_devices and kyc_provider_events still carry the detail columns', () => {
    const devices = modelBlock('KycVerificationDevice');
    for (const column of ['ip_address', 'user_agent', 'device_fingerprint', 'is_vpn_or_tor']) {
      expect(devices, `device.${column} is gone`).toContain(`@map("${column}")`);
    }

    const events = modelBlock('KycProviderEvent');
    for (const column of ['event_id', 'event_type', 'received_at', 'processed_at', 'signature_variant']) {
      expect(events, `event.${column} is gone`).toContain(`@map("${column}")`);
    }
    // And the one the summary deliberately does NOT project.
    expect(events).toContain('payload');
  });

  it('kyc_level_states still carries the pointer the active-credential flag joins on', () => {
    expect(modelBlock('KycLevelState')).toContain('@map("active_verification_id")');
  });

  it('kyc_level_states still carries the column the impact count reads', () => {
    // `impactOf` counts credentials whose `verified_at` falls outside a proposed
    // window. It is the number an operator decides on before de-verifying the platform,
    // so a rename here would silently make that number zero.
    expect(schema).toContain('@@map("kyc_level_states")');
    expect(schema).toContain('@map("verified_at")');
  });

  it('kyc_exemptions still has the live partial index this writer relies on', () => {
    // `ON CONFLICT ("user_id") WHERE "revoked_at" IS NULL` infers THIS index by name of
    // its predicate. If the predicate changes, the grant stops compiling at runtime.
    const sql = read(IDENTITY_SQL);
    expect(sql).toContain('ux_kyc_exemptions_live');
    expect(sql).toMatch(/ux_kyc_exemptions_live[\s\S]{0,200}WHERE revoked_at IS NULL/);
  });
});

describe.skipIf(!present)('every constraint this DTO mirrors still exists', () => {
  const sql = read(IDENTITY_SQL);

  it.each([...new Set(CONSTRAINT_CASES.map((c) => c.constraint!))])(
    '%s is still declared',
    (constraint) => {
      expect(sql, `${constraint} is no longer in identity.sql`).toContain(constraint);
    },
  );

  /**
   * The other direction, and the one that actually earns its keep.
   *
   * A constraint added over there WITHOUT a rule here means this API can write a body
   * the database will reject with a 500. Listing them from the SQL and comparing
   * against the cases means the new one shows up as a failure in this repository.
   */
  it('no kyc_policies constraint exists that the DTO does not mirror', () => {
    const declared = [...sql.matchAll(/'(ck_kyc_policies_[a-z_]+)'/g)].map((m) => m[1]!);
    const mirrored = new Set(CONSTRAINT_CASES.map((c) => c.constraint!));

    expect([...new Set(declared)].filter((name) => !mirrored.has(name))).toEqual([]);
  });
});

describe.skipIf(!present)('the enforcement mirror agrees with narrowPolicy', () => {
  /**
   * `enforcementRejectionOf` reproduces the consumer's four rejection reasons so an
   * admin screen can say "configured but not in force". If `narrowPolicy` gains a
   * fifth, this copy would quietly under-report.
   */
  it('reports the same four reasons narrowPolicy names', () => {
    const source = read(POLICY);
    const reasons = [...source.matchAll(/reason:\s*'([a-z_]+)'/g)].map((m) => m[1]!);

    expect([...new Set(reasons)].sort()).toEqual([
      'incomplete_rolling_window',
      'threshold_without_currency',
      'unknown_level',
      'unknown_region',
    ]);
  });

  const base = {
    region: 'IN',
    level: 'L1',
    balanceThreshold: null,
    lifetimeDepositThreshold: null,
    lifetimeWithdrawalThreshold: null,
    rollingWindowAmount: null,
    rollingWindowSeconds: null,
    rollingWindowOperation: null,
    thresholdCurrency: null,
  };

  it('passes a row the consumer would act on', () => {
    expect(enforcementRejectionOf(base)).toBeNull();
    expect(enforcementRejectionOf({ ...base, region: '*' })).toBeNull();
  });

  it('names a level the consumer cannot read', () => {
    expect(enforcementRejectionOf({ ...base, level: 'L3' })).toBe('unknown_level');
  });

  it('names a region the consumer cannot read', () => {
    expect(enforcementRejectionOf({ ...base, region: '1N' })).toBe('unknown_region');
  });

  it('names a threshold with no currency', () => {
    expect(enforcementRejectionOf({ ...base, balanceThreshold: '100' })).toBe(
      'threshold_without_currency',
    );
  });

  it('names an incomplete rolling window', () => {
    expect(
      enforcementRejectionOf({
        ...base,
        rollingWindowAmount: '100',
        thresholdCurrency: 'USD',
      }),
    ).toBe('incomplete_rolling_window');
  });
});

describe.skipIf(!present)('the trigger-key grammar matches the consumer', () => {
  /**
   * ═══ THE COPY WHERE DRIFT IS SILENT AND EXPENSIVE ══════════════════════════
   *
   * This service writes `identity.kyc_requirements` rows keyed
   * `ADMIN:<REFERENCE>`, and it cannot import the consumer's `buildTriggerKey` to do
   * it. A key spelled differently does not error: it occupies a DIFFERENT slot in
   * `ux_kyc_requirements_open (user_id, trigger_key) WHERE open`, so one
   * administrative decision gets recorded twice and the user is asked to discharge it
   * twice. That is precisely the failure the consumer's `KycRequirementService` header
   * warns about — "eventually mint a key that never matches the first".
   *
   * Every rule below is therefore compared against the consumer's SOURCE rather than
   * against a remembered spelling.
   */

  it('lists the same trigger kinds, in the same order', () => {
    expect(tupleOf(read(CONSTANTS), 'KYC_TRIGGER_KINDS')).toEqual([...KYC_TRIGGER_KINDS]);
  });

  it('writes a kind the consumer recognises', () => {
    expect(tupleOf(read(CONSTANTS), 'KYC_TRIGGER_KINDS')).toContain(ADMIN_TRIGGER_KIND);
  });

  it('uses the consumer’s segment pattern, character for character', () => {
    // Extracted from the consumer's source rather than retyped: a retyped regex is a
    // second spelling of the rule, which is the thing being guarded against.
    const declared = /const TRIGGER_SEGMENT = (\/[^\n]*\/);/.exec(read(UTILITY));
    expect(declared, 'TRIGGER_SEGMENT not found in the consumer').not.toBeNull();
    expect(KYC_TRIGGER_SEGMENT.source).toBe(
      new RegExp(declared![1]!.slice(1, -1)).source,
    );
  });

  it('agrees with the consumer’s pattern on every boundary case', () => {
    // Behavioural as well as textual: if either side is ever rewritten in a different
    // but "equivalent" form, this is what notices they are not.
    const declared = /const TRIGGER_SEGMENT = \/([^\n]*)\/;/.exec(read(UTILITY));
    const consumer = new RegExp(declared![1]!);

    const cases = [
      'CASE-4182',
      'A',
      'A.B_C-D',
      '1CASE',
      'CASE:1',
      '-CASE',
      '.CASE',
      '_CASE',
      'CASE 1',
      'CASE/1',
      'case-4182',
      '',
      'C'.repeat(63),
      'C'.repeat(64),
    ];

    for (const value of cases) {
      expect(KYC_TRIGGER_SEGMENT.test(value), value).toBe(consumer.test(value));
    }
  });

  it('joins on the delimiter the consumer joins on', () => {
    // `[kind, ...segments].join(':')` over there; `${kind}:${segment}` here.
    expect(read(UTILITY)).toContain("join(':')");
    expect(adminTriggerKey('CASE-4182')).toBe('ADMIN:CASE-4182');
  });

  it('uppercases and trims exactly as the consumer does', () => {
    expect(read(UTILITY)).toContain('raw.trim().toUpperCase()');
    expect(adminTriggerKey('  case-4182  ')).toBe('ADMIN:CASE-4182');
  });

  it('still finds ADMIN to be the one kind that tolerates no qualifier over there', () => {
    // The consumer permits `adminTrigger()` with no reference, yielding the bare key
    // `ADMIN`. This service REFUSES that (see `kycRequirementRequestSchema`), because
    // the bare key collides with every other manual requirement for one account. If
    // the consumer ever tightened it, the refusal here would become redundant rather
    // than wrong — but the asymmetry is deliberate and worth pinning.
    expect(read(UTILITY)).toContain("descriptor.kind !== 'ADMIN'");
    expect(() => adminTriggerKey('')).toThrow();
  });

  /** The consumer's `KycRequirement` model block. A local copy of the helper the
   *  policy describe above defines — that one is scoped to its own block, and scoping
   *  it there is what stops a field match landing on a different model. */
  const requirementModel = (): string => {
    // `[{]` / `[}]` and `[^]` rather than escapes, for the reason the other copy
    // states: inside a template literal a single backslash is swallowed before
    // `RegExp` sees it.
    const match = read(SCHEMA).match(new RegExp('^model KycRequirement [{]([^]*?)^[}]', 'm'));
    if (match === null) throw new Error('no model KycRequirement in the consumer schema');
    return match[1] as string;
  };

  it('keeps the requirement columns this writer sets', () => {
    const model = requirementModel();
    for (const column of [
      'required_level',
      'trigger_kind',
      'trigger_key',
      'satisfied_at',
      'satisfied_by_verification_id',
      'waived_at',
      'waived_by',
      'policy_region',
      'policy_version',
    ]) {
      expect(model, column).toContain(column);
    }
  });

  it('keeps the partial unique index this writer’s idempotency rests on', () => {
    // `ON CONFLICT (...) WHERE ...` infers a PARTIAL index, so both the columns AND
    // the predicate have to match or the insert fails outright with "no unique or
    // exclusion constraint matching the ON CONFLICT specification".
    expect(read(IDENTITY_SQL)).toMatch(
      /ux_kyc_requirements_open\s+ON identity\.kyc_requirements \(user_id, trigger_key\)/,
    );
    expect(read(IDENTITY_SQL)).toMatch(
      /ux_kyc_requirements_open[\s\S]*?WHERE satisfied_at IS NULL AND waived_at IS NULL/,
    );
  });

  it('keeps waived_by free of a foreign key, since admin ids live in another schema', () => {
    const model = requirementModel();
    expect(model).toMatch(/waivedBy\s+String\?/);
    expect(model).not.toMatch(/waivedBy[^\n]*@relation/);
  });

  it('still has NO reason column, which is why the waiver reason is audited', () => {
    // No migration was added for one. `ADMIN_KYC_REQUIREMENT_WAIVED` is the sole record
    // of why an obligation was lifted; if this ever fails, that trade has changed.
    const model = requirementModel();
    expect(model).not.toMatch(/waiveReason|waive_reason/);
  });
});

describe.skipIf(!present)('the entitlement vocabularies and columns match the consumer', () => {
  const schema = read(SCHEMA);
  const constants = read(CONSTANTS);

  /**
   * ═══ THE ONE VOCABULARY WHERE `NONE` IS LEGAL ══════════════════════════════
   *
   * `KYC_ENTITLEMENT_LEVELS` is the consumer's `KYC_LEVELS` — all three — and it is the
   * only list in this service that admits `NONE`. Every other level column refuses it,
   * because elsewhere `NONE` is a state rather than a destination; on the entitlement
   * matrix "what may an unverified account do" is a real configuration question.
   *
   * The comparison includes ORDER, because the order is rank order and
   * `GET /kyc-entitlements` returns rows in it — a config screen renders
   * least-privileged first.
   */
  it('entitlement levels are the consumer’s full level ladder, in rank order', () => {
    expect(tupleOf(constants, 'KYC_LEVELS')).toEqual([...KYC_ENTITLEMENT_LEVELS]);
  });

  it('and they are a superset of the levels a policy may demand', () => {
    // A sanity check on the relationship rather than on either list: the requestable
    // levels are the entitlement levels minus `NONE`.
    expect(KYC_ENTITLEMENT_LEVELS.filter((level) => level !== 'NONE')).toEqual([
      ...KYC_POLICY_LEVELS,
    ]);
  });

  /**
   * Every column the entitlement writer names.
   *
   * Seventy-one of them, and this is the check that catches the failure the
   * dboperation's header warns about: this service writes raw SQL against a schema it
   * does not model, so a column renamed in the consumer breaks the writer at RUNTIME
   * with nothing in either type system saying so.
   *
   * Worth more here than on `kyc_policies`, simply by volume — one write statement
   * naming seventy-one columns is seventy-one chances for a rename to go unnoticed.
   */
  const ENTITLEMENT_COLUMNS = [
    'level',
    'configured',
    'withdrawal_limit',
    'exchange_limit',
    'balance_limit',
    'limit_currency',
    'profile_links_enabled',
    'wallet_disabled_currencies',
    'deposit_on_ramp_enabled',
    'deposit_off_ramp_enabled',
    'withdraw_enabled',
    'withdraw_max_per_transaction',
    'withdraw_amount_limit',
    'withdraw_count_limit',
    'withdraw_limit_window_seconds',
    'withdraw_minimum_gap_seconds',
    'withdraw_security_threshold',
    'exchange_enabled',
    'exchange_min_amount',
    'exchange_max_amount',
    'exchange_max_per_exchange',
    'exchange_small_enabled',
    'exchange_multi_coin_enabled',
    'exchange_available_coins',
    'transfer_enabled',
    'transfer_min_amount',
    'transfer_max_amount',
    'transfer_max_per_transfer',
    'transfer_max_per_user',
    'staking_enabled',
    'staking_available_coins',
    'staking_flexible_enabled',
    'staking_locked_enabled',
    'merchant_enabled',
    'merchant_max_websites_or_apps',
    'tools_bulk_payment_enabled',
    'tools_tip_box_enabled',
    'tools_max_tip_boxes',
    'tools_invoice_generator_enabled',
    'tools_max_active_invoices',
    'referral_enabled',
    'referral_allowed_divisions',
    'referral_allowed_tiers',
    'referral_max_active_links',
    'rainpool_eligible',
    'rainpool_can_rain',
    'ptc_can_view_ads',
    'ptc_can_advertise',
    'tasks_can_participate',
    'tasks_can_advertise',
    'tasks_allowed_providers',
    'premium_can_purchase',
    'premium_can_gift',
    'short_link_enabled',
    'advertising_enabled',
    'coupons_can_create',
    'coupons_can_redeem',
    'coupons_can_purchase_third_party',
    'loyalty_enabled',
    'chat_can_access_public_chat',
    'chat_can_advertise',
    'chat_can_send_money',
    'chat_allowed_rooms',
    'ad_exchange_enabled',
    'leaderboard_can_receive_rewards',
    'faucet_enabled',
    'faucet_auto_enabled',
    'faucet_offline_enabled',
    'bankroll_enabled',
    'bankroll_max_investment',
  ];

  const UPGRADE_COLUMNS = [
    'target_level',
    'minimum_balance',
    'deposit_threshold',
    'deposit_window_days',
    'threshold_currency',
  ];

  it.each(ENTITLEMENT_COLUMNS)('kyc_level_entitlements has "%s"', (column) => {
    const mapped = schema.includes(`@map("${column}")`);
    const bare = new RegExp(`^\\s*${column}\\s`, 'm').test(schema);
    expect(mapped || bare, `neither @map("${column}") nor a bare field found`).toBe(true);
  });

  it.each(UPGRADE_COLUMNS)('kyc_upgrade_requirements has "%s"', (column) => {
    const mapped = schema.includes(`@map("${column}")`);
    const bare = new RegExp(`^\\s*${column}\\s`, 'm').test(schema);
    expect(mapped || bare, `neither @map("${column}") nor a bare field found`).toBe(true);
  });

  it('the three tables this surface touches are mapped where expected', () => {
    for (const table of [
      'kyc_level_entitlements',
      'kyc_upgrade_requirements',
      // READ ONLY — a count, so an operator changing a threshold can see who is already
      // through. There is no writer for it in this repository at all.
      'kyc_upgrade_achievements',
    ]) {
      expect(schema, `no @@map("${table}") in the consumer schema`).toContain(
        `@@map("${table}")`,
      );
    }
  });

  it('the level CHECK in the consumer admits NONE on the entitlement table only', () => {
    const sql = read(IDENTITY_SQL);

    // The assertion that keeps this service's one NONE-admitting vocabulary honest: if
    // the consumer ever tightened that CHECK to `('L1','L2')`, every write of the NONE
    // row would fail at the database with nothing here to warn about it first.
    expect(sql).toMatch(
      /ck_kyc_level_entitlements_level[\s\S]{0,200}level IN \('NONE', 'L1', 'L2'\)/,
    );
    // And the target column refuses it, because nobody upgrades to holding nothing.
    expect(sql).toMatch(
      /ck_kyc_upgrade_requirements_level[\s\S]{0,200}target_level IN \('L1', 'L2'\)/,
    );
  });

  it('the consumer still refuses a stored zero, which is what keeps NULL meaning unconfigured', () => {
    const sql = read(IDENTITY_SQL);

    // The DTO mirrors this, and the mirror is only safe while the constraint is there:
    // a stored zero would be a total prohibition wearing the costume of a limit.
    expect(sql).toContain('ck_kyc_level_entitlements_amounts_positive');
    expect(sql).toContain('ck_kyc_level_entitlements_counts_positive');
    expect(sql).toContain('ck_kyc_upgrade_requirements_positive');
  });
});
