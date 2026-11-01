import { describe, expect, it, vi } from 'vitest';
import type { SecurityRestrictionPolicy } from '@prisma/client';
import {
  RestrictionPolicySnapshotService,
  parseQualifiedSubFeature,
  qualifySubFeature,
} from '../../src/restrictions/restrictions.snapshot';
import * as catalogue from '../../src/restrictions/restrictions.catalogue';

/**
 * ═══ THE SNAPSHOT DECIDES WHAT NEVER BECOMES A RESTRICTION ═════════════════
 *
 * Every "no restriction" path in the product converges here, so this file is mostly
 * about REFUSALS: a disabled policy, a non-positive duration, a feature this build
 * does not know, a sub-feature under the wrong parent. Each must drop to "nothing
 * happens" rather than throwing, rather than restricting, and rather than being
 * silently half-applied.
 *
 * The feature hierarchy is INJECTED. `PLATFORM_FEATURES` is `{}` in the product until
 * the real hierarchy is supplied, and these tests must not depend on that staying
 * true — nor invent product features. The fixture names are meaningless on purpose.
 */

const HIERARCHY = {
  'feature-one': ['alpha', 'beta'],
  'feature-two': ['beta'],
  'feature-three': [],
} as const satisfies catalogue.FeatureHierarchy;

/** Point the catalogue's default hierarchy at the fixture for one test file. */
function useFixtureHierarchy(): void {
  vi.spyOn(catalogue, 'isFeature').mockImplementation((v, h) =>
    Object.prototype.hasOwnProperty.call(h ?? HIERARCHY, v),
  );
  vi.spyOn(catalogue, 'isSubFeatureOf').mockImplementation((f, s, h) => {
    const src = (h ?? HIERARCHY) as Record<string, readonly string[]>;
    return (src[f] ?? []).includes(s);
  });
}

function policyRow(over: Partial<SecurityRestrictionPolicy> = {}): SecurityRestrictionPolicy {
  return {
    id: 'p1',
    action: 'password.change',
    context: 'NEW_CONTEXT',
    enabled: true,
    features: [],
    subFeatures: [],
    durationSeconds: 1800,
    version: 3,
    updatedByAdminId: null,
    reason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as SecurityRestrictionPolicy;
}

function snapshotOf(rows: readonly SecurityRestrictionPolicy[]) {
  const db = { listPolicies: vi.fn(async () => rows) };
  return { db, snapshot: new RestrictionPolicySnapshotService(db as never) };
}

describe('the qualified sub-feature encoding', () => {
  it('round-trips', () => {
    expect(parseQualifiedSubFeature(qualifySubFeature('feature-one', 'alpha'))).toEqual({
      feature: 'feature-one',
      subFeature: 'alpha',
    });
  });

  /** A bare id identifies nothing — two features may declare the same sub-feature. */
  it.each(['alpha', '', 'a/b/c', '/alpha', 'feature-one/'])('refuses %j', (value) => {
    expect(parseQualifiedSubFeature(value)).toBeNull();
  });
});

describe('RestrictionPolicySnapshotService', () => {
  it('starts EMPTY — there is no code-level default policy', () => {
    const { snapshot } = snapshotOf([]);
    expect(snapshot.all()).toEqual([]);
    expect(snapshot.policyFor('password.change', 'NEW_CONTEXT')).toBeNull();
    expect(snapshot.loadedAt()).toBeNull();
  });

  it('an unreadable table leaves nothing restricted', async () => {
    const db = { listPolicies: vi.fn(async () => { throw new Error('database is down'); }) };
    const snapshot = new RestrictionPolicySnapshotService(db as never);

    await expect(snapshot.refresh()).resolves.toBeUndefined();
    expect(snapshot.all()).toEqual([]);
  });

  it('RETAINS the previous snapshot when a later refresh fails', async () => {
    useFixtureHierarchy();
    const rows = [policyRow({ features: ['feature-one'] })];
    let fail = false;
    const db = {
      listPolicies: vi.fn(async () => {
        if (fail) throw new Error('transient');
        return rows;
      }),
    };
    const snapshot = new RestrictionPolicySnapshotService(db as never);

    await snapshot.refresh();
    expect(snapshot.policyFor('password.change', 'NEW_CONTEXT')).not.toBeNull();

    fail = true;
    await snapshot.refresh();
    // Still in force: a blip must not silently lift a configured restriction.
    expect(snapshot.policyFor('password.change', 'NEW_CONTEXT')).not.toBeNull();
    vi.restoreAllMocks();
  });

  it('case 17 — a DISABLED policy yields no restriction', async () => {
    useFixtureHierarchy();
    const { snapshot } = snapshotOf([policyRow({ enabled: false, features: ['feature-one'] })]);
    await snapshot.refresh();

    expect(snapshot.policyFor('password.change', 'NEW_CONTEXT')).toBeNull();
    vi.restoreAllMocks();
  });

  it.each([0, -1, -3600])('case 18 — a duration of %d yields no restriction', async (durationSeconds) => {
    useFixtureHierarchy();
    const { snapshot } = snapshotOf([policyRow({ durationSeconds, features: ['feature-one'] })]);
    await snapshot.refresh();

    expect(snapshot.policyFor('password.change', 'NEW_CONTEXT')).toBeNull();
    vi.restoreAllMocks();
  });

  it('case 19 — an unknown feature is dropped and never becomes active', async () => {
    useFixtureHierarchy();
    const { snapshot } = snapshotOf([
      policyRow({ features: ['feature-one', 'no-such-feature'] }),
    ]);
    await snapshot.refresh();

    const resolved = snapshot.policyFor('password.change', 'NEW_CONTEXT');
    expect(resolved?.targets).toEqual([{ feature: 'feature-one', subFeature: null }]);
    vi.restoreAllMocks();
  });

  it('case 20 — a sub-feature under the wrong parent is dropped', async () => {
    useFixtureHierarchy();
    const { snapshot } = snapshotOf([
      policyRow({ subFeatures: ['feature-two/alpha', 'feature-one/alpha'] }),
    ]);
    await snapshot.refresh();

    // `alpha` is declared under feature-one only.
    expect(snapshot.policyFor('password.change', 'NEW_CONTEXT')?.targets).toEqual([
      { feature: 'feature-one', subFeature: 'alpha' },
    ]);
    vi.restoreAllMocks();
  });

  it('drops a policy whose every target is unknown, rather than restricting nothing loudly', async () => {
    useFixtureHierarchy();
    const { snapshot } = snapshotOf([policyRow({ features: ['nope'], subFeatures: ['nope/nope'] })]);
    await snapshot.refresh();

    expect(snapshot.policyFor('password.change', 'NEW_CONTEXT')).toBeNull();
    vi.restoreAllMocks();
  });

  it('ignores an unknown action or context rather than trusting the column', async () => {
    useFixtureHierarchy();
    const { snapshot } = snapshotOf([
      policyRow({ action: 'not.a.trigger', features: ['feature-one'] }),
      policyRow({ context: 'UNCLASSIFIED', features: ['feature-one'] }),
    ]);
    await snapshot.refresh();

    expect(snapshot.all()).toEqual([]);
    vi.restoreAllMocks();
  });

  it('does not double-count a sub-feature whose whole feature is already restricted', async () => {
    useFixtureHierarchy();
    const { snapshot } = snapshotOf([
      policyRow({ features: ['feature-one'], subFeatures: ['feature-one/alpha'] }),
    ]);
    await snapshot.refresh();

    expect(snapshot.policyFor('password.change', 'NEW_CONTEXT')?.targets).toEqual([
      { feature: 'feature-one', subFeature: null },
    ]);
    vi.restoreAllMocks();
  });

  it('carries the policy version through, so a restriction stays explainable', async () => {
    useFixtureHierarchy();
    const { snapshot } = snapshotOf([policyRow({ version: 7, features: ['feature-one'] })]);
    await snapshot.refresh();

    expect(snapshot.policyFor('password.change', 'NEW_CONTEXT')?.version).toBe(7);
    vi.restoreAllMocks();
  });
});
