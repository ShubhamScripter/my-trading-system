import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES } from '../../src/country/country.constants';

/**
 * ═══ THE COPY THAT A SHARED IMPORT WOULD HAVE CHECKED FOR FREE ═════════════
 *
 * `country.constants.ts` duplicates the 249-code ISO list that also lives in
 * `../Orebit-backend/src/utils/country.ts`. There is no shared package between the two
 * services — no workspace, no monorepo — and every other shared constant in this
 * platform is copied the same way, with a drift spec holding the halves together.
 * `security-policies.drift.spec.ts` is the template.
 *
 * The duplication is only safe because of this file, and the stakes here are higher
 * than usual because the value is STORED AND KEYED ON. If the lists drift:
 *
 *   - a code this service accepts but the consumer does not is a country whose flag is
 *     catalogued, uploaded and served, and which no user can ever be registered in;
 *   - a code the consumer accepts but this service does not is a user with a country
 *     the admin surface cannot create, so their flag can never be added.
 *
 * TypeScript would say nothing in either repository about either case.
 *
 * ─── Why it reads the file as TEXT ────────────────────────────────────────
 *
 * Importing across the repository boundary would make this service's build depend on
 * the other service's TypeScript, which is exactly the coupling the copy exists to
 * avoid. Reading the source and extracting the literals asserts agreement without
 * creating a build edge.
 *
 * ─── Why it SKIPS when the sibling is absent ──────────────────────────────
 *
 * This service must build and test on its own — in CI, in a container, from a clone
 * that does not have the consumer backend beside it. A missing sibling is a fact about
 * the checkout rather than a drift, so it is reported and skipped.
 */

const CONSUMER = join(__dirname, '..', '..', '..', 'Orebit-backend', 'src', 'utils', 'country.ts');

/** The string literals of the named `as const` tuple, in declaration order. */
function tupleFrom(source: string, name: string): string[] {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  if (match === null) throw new Error(`could not find ${name} in the consumer's country list`);
  return [...(match[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

const available = existsSync(CONSUMER);
const describeIfPresent = available ? describe : describe.skip;

if (!available) {
  // Visible rather than silent: a skipped drift check should be something a reader
  // notices, not something they have to infer from a missing line.
  console.warn(`country drift check skipped — ${CONSUMER} is not present`);
}

describeIfPresent('the ISO list agrees with the consumer backend', () => {
  const source = available ? readFileSync(CONSUMER, 'utf8') : '';

  it('holds exactly the same codes, in the same order', () => {
    expect(COUNTRY_CODES).toEqual(tupleFrom(source, 'CODES'));
  });

  /**
   * Asserted separately from the equality above so a failure says WHICH way the lists
   * moved. "249 became 248" is a far more useful first line than a 249-element diff.
   */
  it('holds the same number of codes', () => {
    expect(COUNTRY_CODES).toHaveLength(tupleFrom(source, 'CODES').length);
  });
});

describe('the ISO list is internally sound', () => {
  it('contains no duplicates', () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });

  it('is entirely uppercase alpha-2 — anything else would break key derivation', () => {
    for (const code of COUNTRY_CODES) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it('is sorted, so a added entry is a one-line diff in review', () => {
    expect([...COUNTRY_CODES]).toEqual([...COUNTRY_CODES].sort());
  });
});
