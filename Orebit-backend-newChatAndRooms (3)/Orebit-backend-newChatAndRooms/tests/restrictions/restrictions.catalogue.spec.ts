import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATIONS,
  LIVE_TRIGGER_ACTIONS,
  PLATFORM_FEATURES,
  POLICY_CONTEXTS,
  POLICY_FOR_CLASSIFICATION,
  TRIGGER_ACTIONS,
  featureIds,
  isClassification,
  isFeature,
  isPolicyContext,
  isSubFeatureOf,
  isTriggerAction,
  selectableTargets,
  subFeatureIds,
  type Classification,
  type FeatureHierarchy,
} from '../../src/restrictions/restrictions.catalogue';

/**
 * ═══ THE CATALOGUE IS A SET OF TABLES, SO IT IS TESTED AS ONE ═══════════════
 *
 * Nothing in this file computes anything, which makes it exactly the kind of file
 * that breaks silently: a mistyped table entry still compiles, still type-checks, and
 * changes a security decision. So the assertions here are about TOTALITY and about
 * the one mapping whose inversion would be invisible.
 *
 * The feature hierarchy is empty in production until the product supplies it, so its
 * helpers are asserted twice — once against the real (empty) registry to prove the
 * engine is inert, and once against an injected fixture to prove it works when it is
 * not. The fixture names are deliberately meaningless: this file must not become the
 * place someone reads to find out what the platform's features are.
 *
 * Pure, so none of this needs a container, a database or a Redis.
 */

// ─── the trigger actions ────────────────────────────────────────────────────

describe('TRIGGER_ACTIONS', () => {
  it('holds exactly the eight actions the policy covers', () => {
    expect(TRIGGER_ACTIONS).toHaveLength(8);
  });

  it('has no duplicates', () => {
    expect(new Set(TRIGGER_ACTIONS).size).toBe(TRIGGER_ACTIONS.length);
  });

  it.each(TRIGGER_ACTIONS)('recognises %s', (action) => {
    expect(isTriggerAction(action)).toBe(true);
  });

  /**
   * The guard's job is refusal. A membership test written as `includes` passes the
   * happy cases against an implementation that returns `true` unconditionally, so the
   * near-misses are what actually pin it down — and a trimmed or re-cased value
   * arriving from a database column is the realistic way a bad one appears.
   */
  it.each([
    'password.changed',
    'Password.change',
    'PASSWORD.CHANGE',
    ' password.change',
    'password.change ',
    'password',
    '',
    'username.update',
    'antiPhishing.change',
  ])('refuses %j', (value) => {
    expect(isTriggerAction(value)).toBe(false);
  });

  /**
   * The two phone entries exist and are unreachable, and both halves matter. Dropping
   * them would silently remove configuration an operator may already have saved;
   * making them live would wire a trigger to a feature that does not exist.
   */
  it('keeps the two inert phone triggers in the configurable set', () => {
    expect(TRIGGER_ACTIONS).toContain('phone.update');
    expect(TRIGGER_ACTIONS).toContain('phone.remove');
  });

  it('excludes exactly the phone triggers from the live set', () => {
    const omitted = TRIGGER_ACTIONS.filter((action) => !LIVE_TRIGGER_ACTIONS.includes(action));

    expect(omitted).toEqual(['phone.update', 'phone.remove']);
    expect(LIVE_TRIGGER_ACTIONS).toHaveLength(6);
  });

  /**
   * The actions that strengthen an account, and the settings mutations that are not
   * credentials, must never become triggers. Asserted by name rather than by count so
   * the failure message says which one leaked in.
   */
  it.each([
    'passkey.add',
    'authenticator.enable',
    'paymentPin.enable',
    'username.update',
    'antiPhishing.set',
    'antiPhishing.change',
    'social.link',
    'social.unlink',
    'account.delete',
  ])('does not treat %s as a trigger', (action) => {
    expect(isTriggerAction(action)).toBe(false);
  });
});

// ─── the contexts and the fail-safe mapping ─────────────────────────────────

describe('contexts', () => {
  it('offers exactly two configurable contexts', () => {
    expect(POLICY_CONTEXTS).toEqual(['COMMON_IP_DEVICE', 'NEW_CONTEXT']);
  });

  it('can conclude three things, which is one more than it can configure', () => {
    expect(CLASSIFICATIONS).toHaveLength(POLICY_CONTEXTS.length + 1);
    expect(CLASSIFICATIONS).toContain('UNCLASSIFIED');
  });

  it('treats every configurable context as a reachable classification', () => {
    for (const context of POLICY_CONTEXTS) {
      expect(isClassification(context)).toBe(true);
    }
  });

  it('does not let UNCLASSIFIED be configured', () => {
    expect(isPolicyContext('UNCLASSIFIED')).toBe(false);
  });

  it.each(['common_ip_device', 'NEW CONTEXT', 'NEW-CONTEXT', 'A', 'B', ''])(
    'refuses %j as a context',
    (value) => {
      expect(isPolicyContext(value)).toBe(false);
      expect(isClassification(value)).toBe(false);
    },
  );
});

describe('POLICY_FOR_CLASSIFICATION', () => {
  it('maps every classification, leaving no request unresolved', () => {
    for (const classification of CLASSIFICATIONS) {
      expect(POLICY_FOR_CLASSIFICATION[classification]).toBeDefined();
    }
    expect(Object.keys(POLICY_FOR_CLASSIFICATION)).toHaveLength(CLASSIFICATIONS.length);
  });

  it('only ever resolves to a context an Admin can actually configure', () => {
    for (const classification of CLASSIFICATIONS) {
      expect(isPolicyContext(POLICY_FOR_CLASSIFICATION[classification])).toBe(true);
    }
  });

  it.each(POLICY_CONTEXTS)('maps %s to itself', (context) => {
    expect(POLICY_FOR_CLASSIFICATION[context as Classification]).toBe(context);
  });

  /**
   * ═══ THE ONE ASSERTION THIS FILE EXISTS FOR ══════════════════════════════
   *
   * Inverting this single entry would send every unclassifiable request to the
   * lenient policy. Nothing else would fail: the types still hold, the table is still
   * total, every log line still looks ordinary, and the only visible symptom is that
   * restrictions quietly stop being applied to exactly the traffic that could not be
   * vouched for. It is asserted on its own, with its own name, so a failure here
   * reads as the security regression it is.
   */
  it('sends an unclassifiable request to the STRICTER policy', () => {
    expect(POLICY_FOR_CLASSIFICATION.UNCLASSIFIED).toBe('NEW_CONTEXT');
  });
});

// ─── the feature hierarchy, empty and filled ────────────────────────────────

describe('the shipped feature hierarchy', () => {
  /**
   * Production state, and the assertion is the point rather than a placeholder: while
   * this is empty every feature name is unknown, every policy resolves to an empty
   * target set, and no restriction can be created. The engine is inert by data rather
   * than by a flag somebody has to remember to flip.
   */
  it('is empty until the product hierarchy is supplied', () => {
    expect(featureIds()).toEqual([]);
    expect(selectableTargets()).toEqual([]);
  });

  it('recognises no feature at all, so every configured name is dropped', () => {
    for (const name of ['withdrawal', 'transfer', 'anything', '']) {
      expect(isFeature(name)).toBe(false);
      expect(subFeatureIds(name)).toEqual([]);
    }
  });

  /**
   * `{}` inherits from `Object.prototype`, so a naive `hierarchy[value] !== undefined`
   * or `value in hierarchy` would report `constructor`, `toString` and `__proto__` as
   * features — and each of those would then be a storable, matchable feature id.
   */
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'does not mistake the inherited property %j for a feature',
    (name) => {
      expect(isFeature(name)).toBe(false);
      expect(subFeatureIds(name)).toEqual([]);
    },
  );

  it('has the type of a hierarchy, so filling it in needs no other change', () => {
    const shipped: FeatureHierarchy = PLATFORM_FEATURES;
    expect(typeof shipped).toBe('object');
  });
});

describe('the hierarchy helpers, against an injected registry', () => {
  /**
   * Deliberately meaningless ids. Two features share the sub-feature name `beta`,
   * which is the only reason this fixture is shaped the way it is — see the
   * cross-parent case below.
   */
  const FIXTURE = {
    'feature-one': ['alpha', 'beta'],
    'feature-two': ['beta', 'gamma'],
    'feature-three': [],
  } as const satisfies FeatureHierarchy;

  it('lists every feature in declaration order', () => {
    expect(featureIds(FIXTURE)).toEqual(['feature-one', 'feature-two', 'feature-three']);
  });

  it('lists the sub-features of a feature', () => {
    expect(subFeatureIds('feature-one', FIXTURE)).toEqual(['alpha', 'beta']);
  });

  it('gives a feature with no sub-features an empty list rather than undefined', () => {
    expect(subFeatureIds('feature-three', FIXTURE)).toEqual([]);
    expect(isFeature('feature-three', FIXTURE)).toBe(true);
  });

  it('recognises a declared sub-feature under its own parent', () => {
    expect(isSubFeatureOf('feature-one', 'alpha', FIXTURE)).toBe(true);
    expect(isSubFeatureOf('feature-two', 'gamma', FIXTURE)).toBe(true);
  });

  /**
   * ═══ WHY THE GUARD TAKES BOTH ARGUMENTS ═════════════════════════════════
   *
   * `beta` is declared under both features and `alpha` under only one. A validator
   * that accepted a bare sub-feature id would let an operator restrict
   * `feature-two/alpha` — a target that does not exist — and the engine would then
   * write a restriction row nothing could ever match. Both names together are the
   * only thing that identifies a target.
   */
  it('refuses a sub-feature that belongs to a different parent', () => {
    expect(isSubFeatureOf('feature-two', 'alpha', FIXTURE)).toBe(false);
    expect(isSubFeatureOf('feature-one', 'gamma', FIXTURE)).toBe(false);
  });

  it('accepts a shared sub-feature name under each parent that declares it', () => {
    expect(isSubFeatureOf('feature-one', 'beta', FIXTURE)).toBe(true);
    expect(isSubFeatureOf('feature-two', 'beta', FIXTURE)).toBe(true);
  });

  it('refuses any sub-feature of an unknown parent', () => {
    expect(isSubFeatureOf('feature-nine', 'alpha', FIXTURE)).toBe(false);
  });

  /**
   * The whole-feature entry (`subFeature: null`) has to be selectable in its own
   * right, or "restrict this feature entirely" is unrepresentable and an operator has
   * to tick every sub-feature and remember to come back when a new one is added.
   */
  it('offers each feature itself alongside its sub-features', () => {
    expect(selectableTargets(FIXTURE)).toEqual([
      { feature: 'feature-one', subFeature: null },
      { feature: 'feature-one', subFeature: 'alpha' },
      { feature: 'feature-one', subFeature: 'beta' },
      { feature: 'feature-two', subFeature: null },
      { feature: 'feature-two', subFeature: 'beta' },
      { feature: 'feature-two', subFeature: 'gamma' },
      { feature: 'feature-three', subFeature: null },
    ]);
  });

  it('offers every selectable target as a valid pair', () => {
    for (const { feature, subFeature } of selectableTargets(FIXTURE)) {
      expect(isFeature(feature, FIXTURE)).toBe(true);
      if (subFeature !== null) expect(isSubFeatureOf(feature, subFeature, FIXTURE)).toBe(true);
    }
  });
});
