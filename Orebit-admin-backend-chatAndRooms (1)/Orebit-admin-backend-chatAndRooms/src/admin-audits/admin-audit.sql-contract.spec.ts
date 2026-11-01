import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

import {
  ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR,
  ADMIN_AUDIT_SCHEMA_DESCRIPTOR,
} from './admin-audit.payloads.js';

type Domain = keyof typeof ADMIN_AUDIT_SCHEMA_DESCRIPTOR;
type SqlActionContract = Readonly<{
  domain: Domain;
  actions: readonly string[];
  subjects: readonly string[];
  before: readonly string[];
  after: readonly string[];
  requiredMetadata: readonly string[];
  optionalMetadata: readonly string[];
  actors: readonly string[];
  beforeStatuses?: readonly (string | null)[];
  afterStatuses?: readonly string[];
  constraints?: unknown;
}>;
type SqlContract = Readonly<{
  actions: readonly SqlActionContract[];
  validators: Readonly<Record<string, unknown>>;
}>;

const ADMIN_ROOT = process.cwd();
const WORKSPACE = join(ADMIN_ROOT, '..');
const ADMIN_REPOSITORY = join(WORKSPACE, 'admin-backend');
const OREBIT_REPOSITORY = join(WORKSPACE, 'orebit-backend');
const CANONICAL_MIGRATION = join(
  ADMIN_ROOT,
  'src/admin-audits/migrations/202609030001_global_admin_audit_events/migration.sql',
);
const MEMBERSHIP_SQL = join(ADMIN_ROOT, 'src/admin-audits/production-role-memberships.sql');
const RECONCILIATION_MIGRATION = join(ADMIN_ROOT,
  'src/admin-audits/migrations/20260906000001_reconciliation_inactive_null/migration.sql');
const CONFIGURATION_MIGRATION = join(ADMIN_ROOT,
  'src/admin-audits/migrations/20260910000015_wallet_pricing_configuration/migration.sql');
const UNAVAILABLE_TARGET_MIGRATION = join(ADMIN_ROOT,
  'src/admin-audits/migrations/20260910000016_unavailable_pricing_target/migration.sql');
const HISTORY_BUDGET_MIGRATION = join(ADMIN_ROOT,
  'src/admin-audits/migrations/20260910000017_history_payload_budget/migration.sql');
const TIMESTAMP_GRAMMAR_MIGRATION = join(ADMIN_ROOT,
  'src/admin-audits/migrations/20260910000018_wallet_timestamp_grammar/migration.sql');
const SCHEDULED_BUSINESS_MIGRATION = join(ADMIN_ROOT,
  'src/admin-audits/migrations/20260910000019_scheduled_wallet_business/migration.sql');
const PRICING_AUDIT_GRANTS = new Set([
  'admin-backend/src/wallet/core/migrations/20260910000014_wp11_audit_capability/migration.sql',
  'orebit-backend/src/wallet/core/migrations/20260910000014_wp11_audit_capability/migration.sql',
]);
const CLIENTS = new Set([
  'orebit-backend/src/wallet/price-conversion/scheduled-audit.ts',
  'admin-backend/src/admin-audits/admin-audit.repository.ts',
  'orebit-backend/src/wallet/core/admin-audit-sql.ts',
]);
const READERS = new Set([
  'admin-backend/src/admin-audits/admin-audit.database.ts',
  'admin-backend/src/admin-audits/admin-audit.history-repository.ts',
]);
const TEST_HARNESSES = new Set([
  'orebit-backend/src/wallet/core/tests/wp11-worker-full-pipeline.postgres.test.ts',
  'orebit-backend/src/wallet/core/tests/wp11-worker-process-recovery.postgres.test.ts',
  'admin-backend/src/wallet/core/tests/wp11-admin-wallet.integration.spec.ts',
  'admin-backend/src/wallet/core/tests/final-integration.spec.ts',
  'orebit-backend/src/wallet/price-conversion/tests/governance-patch.integration.test.ts',
  'orebit-backend/src/wallet/price-conversion/tests/scheduled-config-corrections.test.ts',
  'orebit-backend/src/wallet/price-conversion/tests/wp11-price-engine.postgres.test.ts',
  'admin-backend/src/wallet/price-conversion/price-conversion.wp11.integration.spec.ts',
  'admin-backend/src/admin-audits/admin-audit.configuration.postgres.spec.ts',
  'orebit-backend/src/wallet/deposit/tests/support/provision-deposit.ts',
  'admin-backend/src/admin-audits/admin-audit.history.spec.ts',
  'admin-backend/src/admin-audits/admin-audit.postgres.spec.ts',
  'admin-backend/src/admin-audits/admin-audit.sql-contract.spec.ts',
  'admin-backend/src/wallet/core/tests/configuration.persistence.spec.ts',
  'admin-backend/src/wallet/core/tests/configuration.review-fixes.spec.ts',
  'admin-backend/src/wallet/core/tests/configuration.zz-atomicity.spec.ts',
  'admin-backend/src/wallet/core/tests/currency-chain-pin.persistence.spec.ts',
  'admin-backend/src/wallet/core/tests/deployment-contract.spec.ts',
  'admin-backend/src/wallet/core/tests/test-database-safety.spec.ts',
  'admin-backend/src/wallet/core/tests/ownership-fixtures.ts',
  'admin-backend/src/wallet/core/tests/worker-membership.security.spec.ts',
  'admin-backend/src/admin-audits/admin-audit.postgres.fixtures.ts',
  'admin-backend/src/admin-audits/admin-audit.postgres.schema-tests.ts',
  'admin-backend/src/admin-audits/admin-audit.postgres.role-tests.ts',
  'admin-backend/src/admin-audits/admin-audit.postgres.action-matrix-tests.ts',
  'admin-backend/src/admin-audits/admin-audit.postgres.action-rule-tests.ts',
  'admin-backend/src/admin-audits/admin-audit.postgres.payload-validation-tests.ts',
  'admin-backend/src/admin-audits/admin-audit.postgres.persistence-tests.ts',
  'orebit-backend/src/wallet/core/tests/lifecycle-fixture.ts',
  'orebit-backend/src/wallet/core/tests/provision-lifecycle-database.ts',
  'orebit-backend/src/wallet/core/tests/forfeiture-worker.integration.test.ts',
  'orebit-backend/src/wallet/core/tests/lifecycle-worker.integration.test.ts',
  'orebit-backend/src/wallet/core/tests/lifecycle-review.integration.test.ts',
  'orebit-backend/src/wallet/core/tests/reconciliation-runtime.persistence.test.ts',
  'orebit-backend/src/wallet/core/tests/reconciliation-worker.integration.test.ts',
]);
const ADMIN_SCHEMA = String.raw`"?admin"?`;
const AUDIT_TABLE = String.raw`${ADMIN_SCHEMA}\s*\.\s*"?admin_audit_events"?`;
const APPEND_FUNCTION = String.raw`${ADMIN_SCHEMA}\s*\.\s*"?append_admin_audit_event_v1"?`;
const IMMUTABILITY_FUNCTION = String.raw`(?:${ADMIN_SCHEMA}\s*\.\s*)?"?reject_admin_audit_(?:row_mutation|truncate)_v1"?`;
const IMMUTABILITY_TRIGGER = String.raw`"?admin_audit_events_reject_(?:row_mutation|truncate)"?`;
const AUDIT_ROLE = String.raw`"?orebit_admin_audit_(?:owner|writer|reader)"?`;
const RESTRICTED_AUDIT_REFERENCE = new RegExp(
  [AUDIT_TABLE, APPEND_FUNCTION, IMMUTABILITY_FUNCTION, IMMUTABILITY_TRIGGER, AUDIT_ROLE].join('|'),
  'i',
);
const TABLE_MUTATION = new RegExp(
  String.raw`\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${AUDIT_TABLE}|\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+${AUDIT_TABLE}`,
  'i',
);
const OBJECT_DEFINITION = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:${APPEND_FUNCTION}|${IMMUTABILITY_FUNCTION})|\bCREATE\s+TRIGGER\s+${IMMUTABILITY_TRIGGER}`,
  'i',
);
const ROLE_DEFINITION = new RegExp(String.raw`\b(?:CREATE|ALTER|DROP)\s+ROLE\s+${AUDIT_ROLE}`, 'i');
const AUDIT_TABLE_REFERENCE = new RegExp(AUDIT_TABLE, 'i');
const APPEND_CALL =
  /\b(?:SELECT|PERFORM)\s+(?:\*\s+FROM\s+)?"?admin"?\s*\.\s*"?append_admin_audit_event_v1"?\s*\(/i;

function normalize(path: string): string {
  return relative(WORKSPACE, path).replace(/\\/g, '/');
}

function assertReaderOnlyReference(name: string, text: string): void {
  assert.doesNotMatch(text, TABLE_MUTATION, name + ' must not mutate or define the audit table');
  assert.doesNotMatch(text, OBJECT_DEFINITION, name + ' must not define audit objects');
  assert.doesNotMatch(text, ROLE_DEFINITION, name + ' must not own audit roles');
  assert.doesNotMatch(text, APPEND_CALL, name + ' must not call the append function');
  if (name.endsWith('admin-audit.history-repository.ts')) {
    assert.match(
      text,
      /\bSELECT\b[\s\S]*\bFROM\s+"?admin"?\s*\.\s*"?admin_audit_events"?/i,
    );
  }
}

async function filesUnder(root: string, accept: (name: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !['.git', '.test-dist', 'coverage', 'dist', 'node_modules'].includes(entry.name)) {
      files.push(...(await filesUnder(join(root, entry.name), accept)));
    } else if (entry.isFile() && accept(entry.name)) {
      files.push(join(root, entry.name));
    }
  }
  return files;
}

function parseSqlContract(sql: string): SqlContract {
  const match = /v_contract jsonb := \$admin_audit_contract\$([\s\S]*?)\$admin_audit_contract\$::jsonb;/.exec(sql);
  assert.ok(match?.[1], 'append function must declare its machine-readable runtime contract');
  return JSON.parse(match[1]) as SqlContract;
}

function typescriptActions(): Readonly<Record<Domain, Readonly<Record<string, Omit<SqlActionContract, 'domain' | 'actions'>>>>> {
  return Object.fromEntries(
    Object.entries(ADMIN_AUDIT_SCHEMA_DESCRIPTOR).map(([domain, actions]) => [
      domain,
      Object.fromEntries(
        Object.entries(actions).map(([action, descriptor]) => [
          action,
          {
            subjects: [...descriptor.subject],
            before: [...(descriptor.constraints?.requiredBefore ?? descriptor.state)],
            after: [...(descriptor.constraints?.requiredAfter ?? descriptor.state)],
            requiredMetadata: [...descriptor.required],
            optionalMetadata: [...descriptor.optional],
            actors: [...descriptor.actors],
            ...(descriptor.beforeStatuses ? { beforeStatuses: [...descriptor.beforeStatuses] } : {}),
            ...(descriptor.afterStatuses ? { afterStatuses: [...descriptor.afterStatuses] } : {}),
            ...('constraints' in descriptor ? { constraints: structuredClone(descriptor.constraints) } : {}),
          },
        ]),
      ),
    ]),
  ) as unknown as Readonly<Record<Domain, Readonly<Record<string, Omit<SqlActionContract, 'domain' | 'actions'>>>>>;
}

function sqlActions(contract: SqlContract): ReturnType<typeof typescriptActions> {
  const expanded = { WALLET_CORE: {}, DEPOSIT: {} } as Record<Domain, Record<string, Omit<SqlActionContract, 'domain' | 'actions'>>>;
  for (const group of contract.actions) {
    const { domain, actions, ...descriptor } = group;
    for (const action of actions) {
      assert.equal(expanded[domain][action], undefined, `duplicate SQL contract pair ${domain}/${action}`);
      expanded[domain][action] = descriptor;
    }
  }
  return expanded;
}

function migrationOrder(document: string): readonly { readonly name: string; readonly planned: boolean }[] {
  const section = document.match(/## Canonical migration order\s*([\s\S]*?)(?=\n## |\n---|$)/)?.[1];
  assert.ok(section, 'canonical migration order section must exist');
  const plannedAt = section.search(/\bplanned\b/i);
  const entries = [...section.matchAll(/`((?:\d{12}|\d{14})_[a-z0-9_]+)`/g)].map((match) => ({
    name: match[1] as string,
    planned: plannedAt >= 0 && (match.index ?? -1) > plannedAt,
  }));
  assert.ok(entries.length >= 7, 'canonical migration order must retain its historical prerequisites');
  assert.equal(new Set(entries.map(({ name }) => name)).size, entries.length);
  return entries;
}

test('preserves the 56 legacy scalar domain/action contracts; the forward contract is verified against live SQL', async () => {
  const sql = await readFile(CANONICAL_MIGRATION, 'utf8');
  const contract = parseSqlContract(sql);
  const forward=await readFile(RECONCILIATION_MIGRATION,'utf8');
  const nullableCondition=/\$new_null\$([\s\S]*?)\$new_null\$/.exec(forward)?.[1];
  assert.ok(nullableCondition,'forward migration must declare the replacement null condition');
  (contract.validators.shortfallPercent as Record<string,unknown>).nullableWhen=JSON.parse(nullableCondition);
  const actions = sqlActions(contract);
  const current = typescriptActions();
  const scheduledBusiness = new Set(['CHAIN.UPDATED','CHAIN.IMPORTED','CURRENCY.UPDATED','CURRENCY.IMPORTED','PROVIDER_MAINTENANCE.PINNED','PROVIDER_MAINTENANCE.UNPINNED']);
  const legacyWallet = Object.fromEntries(Object.entries(current.WALLET_CORE).map(([action, definition]) => [action,
    scheduledBusiness.has(action) ? { ...definition, actors: definition.actors.filter(actor => actor !== 'SYSTEM'), optionalMetadata: definition.optionalMetadata.filter(key => key !== 'scheduledChangeId') } : definition,
  ]));
  assert.deepEqual(actions, { WALLET_CORE: legacyWallet, DEPOSIT: current.DEPOSIT });
  const { configChangeId: _configChangeId, changelog: _changelog, ...legacyValidators } = ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR;
  assert.deepEqual(contract.validators, legacyValidators);
  assert.deepEqual(
    (contract.validators.shortfallPercent as Record<string, unknown>).nullableWhen,
    {
      domain: 'WALLET_CORE',
      actions: ['RECONCILIATION.WARNING_RAISED', 'RECONCILIATION.WARNING_CLEARED'],
      sections: ['before', 'after'],
      key: 'partial',
      equals: true,
      allowInactive: true,
    },
  );
  assert.equal(Object.isFrozen(
    (ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR.shortfallPercent as {
      readonly nullableWhen?: Readonly<Record<string, unknown>>;
    }).nullableWhen,
  ), true);
  assert.equal(Object.keys(actions.WALLET_CORE).length, 26);
  assert.equal(Object.keys(actions.DEPOSIT).length, 30);
  const transitions = {
    'SETTINGS.SAVED': { beforeStatuses: [null], afterStatuses: ['DRAFT'] },
    'SETTINGS.PUSHED': { beforeStatuses: ['DRAFT'], afterStatuses: ['LIVE'] },
    'SETTINGS.SCHEDULED': { beforeStatuses: ['DRAFT'], afterStatuses: ['SCHEDULED'] },
    'SETTINGS.SCHEDULE_APPLIED': { beforeStatuses: ['SCHEDULED'], afterStatuses: ['LIVE'] },
    'SETTINGS.SCHEDULE_REJECTED': { beforeStatuses: ['SCHEDULED'], afterStatuses: ['REJECTED'] },
  };
  for (const domain of ['WALLET_CORE', 'DEPOSIT'] as const) {
    for (const [action, transition] of Object.entries(transitions)) {
      assert.deepEqual(actions[domain][action]?.beforeStatuses, transition.beforeStatuses);
      assert.deepEqual(actions[domain][action]?.afterStatuses, transition.afterStatuses);
    }
  }
  assert.deepEqual(actions.WALLET_CORE['LOGO.UPLOADED'], {
    subjects: ['LOGO_ASSET'], before: ['stored'],
    after: ['stored', 'mediaType', 'width', 'height', 'bytes'], requiredMetadata: ['sourceFormat'],
    optionalMetadata: [], actors: ['ADMIN'], constraints: {
      reason: 'wallet-logo-upload', requiredBefore: ['stored'],
      requiredAfter: ['stored', 'mediaType', 'width', 'height', 'bytes'],
      fixedBefore: { stored: false }, fixedAfter: { stored: true, mediaType: 'image/webp' },
      equalAfter: [['width', 'height']],
    },
  });
  assert.deepEqual(actions.WALLET_CORE['CURRENCY.STATUS_CHANGED']?.subjects, ['CURRENCY', 'CURRENCY_CHAIN']);
  for (const action of ['PROVIDER_MAINTENANCE.ENTERED', 'PROVIDER_MAINTENANCE.RECOVERED']) {
    assert.deepEqual(actions.WALLET_CORE[action]?.subjects, ['CHAIN', 'CURRENCY', 'CURRENCY_CHAIN']);
  }
  for (const action of ['PROVIDER_MAINTENANCE.PINNED', 'PROVIDER_MAINTENANCE.UNPINNED']) {
    assert.deepEqual(actions.WALLET_CORE[action]?.subjects, ['CHAIN', 'CURRENCY_CHAIN']);
  }
  for (const action of ['CURRENCY.CREATED', 'CURRENCY.UPDATED', 'CURRENCY.IMPORTED',
    'PRICE_MAINTENANCE.ENTERED', 'PRICE_MAINTENANCE.RECOVERED']) {
    assert.equal(actions.WALLET_CORE[action]?.subjects.includes('CURRENCY_CHAIN'), false, action);
  }
  for (const [action, descriptor] of Object.entries(actions.DEPOSIT)) {
    assert.equal(descriptor.subjects.includes('CURRENCY_CHAIN'), false, `DEPOSIT/${action}`);
  }

  const functionBody = sql.slice(sql.indexOf('CREATE FUNCTION admin.append_admin_audit_event_v1'));
  assert.match(functionBody, /jsonb_array_elements\(v_contract->'actions'\)/);
  assert.match(functionBody, /candidate->>'domain' = p_domain AND \(candidate->'actions'\) \? p_action/);
  assert.match(functionBody, /v_validator := v_contract #> ARRAY\['validators', v_entry\.key\]/);
  assert.match(functionBody, /v_nullable_when := v_validator->'nullableWhen'/);
  assert.match(functionBody, /v_nullable_when->'actions'/);
  assert.match(functionBody, /v_nullable_when->'sections'/);
  assert.match(functionBody, /v_before - v_before_keys/);
  assert.match(functionBody, /v_after - v_after_keys/);
  assert.match(functionBody, /NOT \(v_metadata \?& v_required_keys\)/);
  assert.match(functionBody, /NOT \(\(v_action_contract->'actors'\) \? p_actor_kind\)/);
  assert.match(functionBody, /v_action_contract->'beforeStatuses'/);
  assert.match(functionBody, /v_action_contract->'afterStatuses'/);
  assert.match(functionBody, /v_action_contract\s*#>\s*'\{constraints,/);
  assert.doesNotMatch(functionBody, /CASE\s+WHEN p_action IN/);
});

test('derives one current logical migration prefix from both canonical documents', async () => {
  const [design, plan, migrations] = await Promise.all([
    readFile(join(ADMIN_ROOT, 'src/admin-audits/DESIGN.md'), 'utf8'),
    readFile(join(ADMIN_ROOT, 'src/admin-audits/IMPLEMENTATION_PLAN.md'), 'utf8'),
    Promise.all(
      [ADMIN_REPOSITORY, OREBIT_REPOSITORY].map((root) =>
        filesUnder(root, (name) => name === 'migration.sql'),
      ),
    ).then((groups) => groups.flat()),
  ]);
  const designOrder = migrationOrder(design);
  const planOrder = migrationOrder(plan);
  assert.deepEqual(planOrder, designOrder);
  assert.notDeepEqual(
    designOrder.map(({ name }) => name),
    designOrder.map(({ name }) => name).sort(),
    'logical cross-schema order must not collapse into timestamp sorting',
  );

  const locations = new Map<string, string[]>();
  for (const path of migrations) {
    const name = dirname(path).split(/[\\/]/).at(-1) as string;
    const paths = locations.get(name) ?? [];
    paths.push(normalize(path));
    locations.set(name, paths);
  }
  const current = designOrder.filter(({ planned }) => !planned);
  assert.ok(current.length > 0);
  for (const { name } of current) assert.ok(locations.has(name), `missing current prerequisite ${name}`);
  assert.equal(locations.get(current[0]?.name ?? '')?.length, 1, 'Admin audit migration must exist once');
  assert.equal(normalize(CANONICAL_MIGRATION), locations.get(current[0]?.name ?? '')?.[0]);
});

test('recognizes mixed-case and quoted spellings of every canonical audit identifier', () => {
  for (const source of [
    'CREATE TABLE AdMiN.AdMiN_AuDiT_Events (id uuid)',
    'SELECT "admin"."append_admin_audit_event_v1"()',
    'CREATE FUNCTION "admin"."reject_admin_audit_truncate_v1"()',
    'CREATE TRIGGER "admin_audit_events_reject_row_mutation"',
    'ALTER ROLE "orebit_admin_audit_writer" NOLOGIN',
  ]) assert.match(source, RESTRICTED_AUDIT_REFERENCE);
  assert.match('INSERT INTO "admin"."admin_audit_events" DEFAULT VALUES', TABLE_MUTATION);
  assert.match('CREATE FUNCTION "admin"."append_admin_audit_event_v1"()', OBJECT_DEFINITION);
  assert.match('ALTER ROLE "orebit_admin_audit_owner" NOLOGIN', ROLE_DEFINITION);
});

test('keeps both exact reader files SELECT-only under negative mutation fixtures', () => {
  for (const name of READERS) {
    for (const text of [
      'INSERT INTO admin.admin_audit_events (id) VALUES ($1)',
      'UPDATE admin.admin_audit_events SET reason = $1',
      'DELETE FROM admin.admin_audit_events',
      'CREATE TABLE admin.admin_audit_events (id uuid)',
      'SELECT * FROM admin.append_admin_audit_event_v1($1)',
    ]) assert.throws(() => assertReaderOnlyReference(name, text));
  }
});

test('keeps every production audit object, role, and write reference under sole ownership', async () => {
  const files = (
    await Promise.all(
      [ADMIN_REPOSITORY, OREBIT_REPOSITORY].map((root) =>
        filesUnder(root, (name) => /\.(?:sql|ts)$/.test(name)),
      ),
    )
  ).flat();
  for (const path of files) {
    const text = await readFile(path, 'utf8');
    if (!RESTRICTED_AUDIT_REFERENCE.test(text)) continue;
    const name = normalize(path);
    if (TEST_HARNESSES.has(name)) continue;
    if (/\.(?:spec|test)\.ts$/.test(path)) {
      assert.ok(TEST_HARNESSES.has(name), `noncanonical audit test reference: ${name}`);
      continue;
    }
    if (path === CANONICAL_MIGRATION || path === RECONCILIATION_MIGRATION || path === CONFIGURATION_MIGRATION || path === UNAVAILABLE_TARGET_MIGRATION || path === HISTORY_BUDGET_MIGRATION || path === TIMESTAMP_GRAMMAR_MIGRATION || path === SCHEDULED_BUSINESS_MIGRATION) continue;
    if (PRICING_AUDIT_GRANTS.has(name)) {
      assert.doesNotMatch(text, TABLE_MUTATION, name + ' must not mutate Audit data');
      assert.doesNotMatch(text, OBJECT_DEFINITION, name + ' must not define Audit objects');
      assert.doesNotMatch(text, ROLE_DEFINITION, name + ' must not own Audit roles');
      continue;
    }
    if (path === MEMBERSHIP_SQL) {
      assert.doesNotMatch(text, TABLE_MUTATION, `${name} must not mutate the audit table`);
      assert.doesNotMatch(text, OBJECT_DEFINITION, `${name} must not define audit objects`);
      assert.doesNotMatch(text, ROLE_DEFINITION, `${name} must not own audit roles`);
      continue;
    }
    if (READERS.has(name)) {
      assertReaderOnlyReference(name, text);
      continue;
    }
    if (CLIENTS.has(name)) {
      assert.match(text, /SELECT[\s\S]*admin\.append_admin_audit_event_v1\s*\(/i, `${name} must only call the append function`);
      assert.doesNotMatch(text, AUDIT_TABLE_REFERENCE, `${name} must not access the table`);
      assert.doesNotMatch(text, OBJECT_DEFINITION, `${name} must not define audit objects`);
      assert.doesNotMatch(text, ROLE_DEFINITION, `${name} must not own audit roles`);
      continue;
    }
    assert.fail(`noncanonical production audit ownership reference: ${name}`);
  }
});
