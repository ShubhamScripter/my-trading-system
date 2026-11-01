import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POLICY_CONTEXTS,
  TRIGGER_ACTIONS,
} from '../../src/security-policies/security-policies.types';

/**
 * ═══ THE COPY THAT A SHARED IMPORT WOULD HAVE CHECKED FOR FREE ═════════════
 *
 * `security-policies.types.ts` duplicates two string tuples that also live in
 * `../Orebit-backend/src/restrictions/restrictions.catalogue.ts`. There is no shared
 * package between the two services — no workspace, no monorepo, and every other shared
 * thing in this platform is copied the same way.
 *
 * The duplication is only safe because of this file. These values are STORED: an admin
 * writes `password.change` into `identity.security_restriction_policies.action`, and
 * the consumer backend matches on it. If the lists drift, TypeScript says nothing in
 * either repository — the symptom is a policy an operator configured that silently
 * matches nothing and restricts nobody.
 *
 * ─── Why it reads the file as TEXT ────────────────────────────────────────
 *
 * Importing across the repository boundary would mean this service's build depending
 * on the other service's TypeScript, which is exactly the coupling the copy exists to
 * avoid. Reading the source and extracting the literals asserts agreement without
 * creating a build edge.
 *
 * ─── Why it SKIPS when the sibling is absent ──────────────────────────────
 *
 * This service must build and test on its own — in CI, in a container, from a clone
 * that does not have the consumer backend beside it. A missing sibling is a fact about
 * the checkout rather than a drift, so it is reported and skipped. When the two ARE
 * side by side, which is how they are developed, the check runs.
 */

const CATALOGUE = join(
  __dirname,
  '..',
  '..',
  '..',
  'Orebit-backend',
  'src',
  'restrictions',
  'restrictions.catalogue.ts',
);

/** The string literals of a named `as const` tuple, in declaration order. */
function tupleFrom(source: string, name: string): string[] {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  if (match === null) throw new Error(`could not find ${name} in the consumer catalogue`);
  return [...(match[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

const available = existsSync(CATALOGUE);
const describeIfPresent = available ? describe : describe.skip;

if (!available) {
  // Visible rather than silent: a skipped drift check should be something a reader
  // notices in the output, not something they have to go looking for.
  console.warn(
    `[security-policies.drift] consumer catalogue not found at ${CATALOGUE} — skipping. ` +
      'Run with ../Orebit-backend checked out beside this repository to assert agreement.',
  );
}

describeIfPresent('the trigger registry agrees with the consumer backend', () => {
  const source = available ? readFileSync(CATALOGUE, 'utf8') : '';

  it('declares the same trigger actions, in the same order', () => {
    expect(tupleFrom(source, 'TRIGGER_ACTIONS')).toEqual([...TRIGGER_ACTIONS]);
  });

  it('declares the same configurable contexts', () => {
    expect(tupleFrom(source, 'POLICY_CONTEXTS')).toEqual([...POLICY_CONTEXTS]);
  });

  /**
   * The one value that must NOT be configurable.
   *
   * `UNCLASSIFIED` is a conclusion the consumer's evaluator reaches when a request
   * matches neither rule; it resolves to `NEW_CONTEXT`'s policy. If it ever appeared in
   * the configurable list, an operator could configure the fail-safe bucket — and
   * could configure it more leniently than the strict policy it exists to fall back to.
   */
  it('does not let UNCLASSIFIED become a configurable context on either side', () => {
    expect(tupleFrom(source, 'POLICY_CONTEXTS')).not.toContain('UNCLASSIFIED');
    expect([...POLICY_CONTEXTS]).not.toContain('UNCLASSIFIED');
    // It IS a classification over there, which is the distinction being preserved.
    expect(tupleFrom(source, 'CLASSIFICATIONS')).toContain('UNCLASSIFIED');
  });

  /** The two phone triggers are configurable on both sides and inert on both. */
  it('keeps the inert phone triggers in both registries', () => {
    for (const action of ['phone.update', 'phone.remove']) {
      expect(tupleFrom(source, 'TRIGGER_ACTIONS')).toContain(action);
      expect([...TRIGGER_ACTIONS]).toContain(action);
    }
  });
});
