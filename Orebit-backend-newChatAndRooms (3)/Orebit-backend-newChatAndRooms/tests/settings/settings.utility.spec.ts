import { describe, expect, it } from 'vitest';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  PATH_BY_PROOF_FIELD,
  DISABLE_PATHS,
  emailCodeRequiredForPath,
  type DisablePath,
  type DisableProofs,
  type ProofField,
} from '../../src/settings/settings.types';
import { resolveDisablePath } from '../../src/settings/settings.utility';

/**
 * ═══ THE DISABLE POLICY IS A TABLE, SO IT IS TESTED AS ONE ══════════════════
 *
 * `resolveDisablePath` is the whole of "which of the four paths did the caller
 * name", and its interesting behaviour is what it REFUSES. A test that only walked
 * the four happy paths would pass against an implementation that accepted every
 * combination and picked the first proof it found — which is precisely the
 * permissive shape this function exists to not be.
 *
 * So the combinations are enumerated rather than chosen: every pair of proof fields
 * is asserted to conflict, and every path is asserted to demand or refuse the
 * emailed code according to the one table that decides.
 *
 * Pure, so none of this needs a container, a database or a Redis.
 */

const PROOF_FIELDS = Object.keys(PATH_BY_PROOF_FIELD) as readonly ProofField[];

/** A syntactically plausible value for each proof field. Nothing here is verified —
 *  the resolver only looks at which fields are PRESENT. */
const SAMPLE: Readonly<Record<ProofField, unknown>> = {
  passkey: { id: 'credential-id' } as unknown as AuthenticationResponseJSON,
  totpCode: '123456',
  backupCode: '4X7K9-M2QRT',
  kyc: { reference: 'provider-handle' },
};

function proofs(fields: readonly ProofField[], emailCode?: string): DisableProofs {
  const built: Record<string, unknown> = {};
  for (const field of fields) built[field] = SAMPLE[field];
  if (emailCode !== undefined) built.emailCode = emailCode;
  return built as DisableProofs;
}

/** Every unordered pair of distinct proof fields. */
const PAIRS = PROOF_FIELDS.flatMap((a, i) =>
  PROOF_FIELDS.slice(i + 1).map((b) => [a, b] as const),
);

describe('the four paths, each in isolation', () => {
  it.each(PROOF_FIELDS.map((field) => [field, PATH_BY_PROOF_FIELD[field]] as const))(
    '%s alone names the "%s" path',
    (field, expected) => {
      const emailCode = emailCodeRequiredForPath(expected) ? '000000' : undefined;
      const result = resolveDisablePath(proofs([field], emailCode));

      expect(result.ok).toBe(true);
      expect(result.ok && result.path).toBe(expected);
    },
  );

  it('covers every path in the union', () => {
    // A guard on the enumeration itself: if a fifth path is added and this file is
    // not updated, the suite above would still pass while testing three quarters of
    // the policy.
    const reachable = new Set<DisablePath>(
      PROOF_FIELDS.map((field) => PATH_BY_PROOF_FIELD[field]),
    );
    expect([...reachable].sort()).toEqual([...DISABLE_PATHS].sort());
  });
});

describe('ambiguity is refused, not resolved', () => {
  it.each(PAIRS.map(([a, b]) => [`${a} + ${b}`, a, b] as const))(
    '%s is refused',
    (_label, a, b) => {
      // Both need an email code at most; supply one so the refusal cannot be
      // mistaken for the missing-code refusal.
      const result = resolveDisablePath(proofs([a, b], '000000'));

      expect(result.ok).toBe(false);
      // Every conflicting field is named, because the mistake is the combination and
      // there is no basis for calling either one the intended path.
      const paths = result.ok ? [] : result.problems.map((p) => p.path);
      expect(paths.sort()).toEqual([a, b].sort());
    },
  );

  it('refuses all four at once', () => {
    const result = resolveDisablePath(proofs(PROOF_FIELDS, '000000'));
    expect(result.ok).toBe(false);
  });

  it('names the conflicting path in the message, so a client can say which', () => {
    const result = resolveDisablePath(proofs(['passkey', 'totpCode'], '000000'));
    expect(result.ok).toBe(false);
    const messages = result.ok ? [] : result.problems.map((p) => p.message);
    expect(messages.join(' ')).toContain('passkey+otp');
    expect(messages.join(' ')).toContain('totp+otp');
  });
});

describe('no path at all', () => {
  it('refuses an empty request and lists the options', () => {
    const result = resolveDisablePath({});

    expect(result.ok).toBe(false);
    const problem = result.ok ? undefined : result.problems[0];
    // Anchored on the request as a whole, not on a field — there is no one field to
    // blame when none was sent.
    expect(problem?.path).toBe('');
    for (const field of PROOF_FIELDS) {
      expect(problem?.message).toContain(field);
    }
  });

  it('refuses an emailed code with nothing to pair it with', () => {
    // Otherwise the emailed code alone would look like a path, and a caller who sent
    // only it would get a wrong-code error instead of being told what is missing.
    const result = resolveDisablePath({ emailCode: '000000' });
    expect(result.ok).toBe(false);
  });
});

describe('the emailed code, per path', () => {
  it('is required by every path except backup-code', () => {
    // The table this asserts is the product rule: a backup code is the path for
    // someone whose FACTOR is gone, and a mailbox round trip would re-close it.
    expect(
      DISABLE_PATHS.filter((path: DisablePath) => !emailCodeRequiredForPath(path)),
    ).toEqual(['backup-code']);
  });

  it.each(
    PROOF_FIELDS.filter((field) => emailCodeRequiredForPath(PATH_BY_PROOF_FIELD[field])).map(
      (field) => [field, PATH_BY_PROOF_FIELD[field]] as const,
    ),
  )('%s without emailCode is refused, naming the field', (field, path) => {
    const result = resolveDisablePath(proofs([field]));

    expect(result.ok).toBe(false);
    const problem = result.ok ? undefined : result.problems[0];
    expect(problem?.path).toBe('emailCode');
    expect(problem?.message).toContain(path);
    // Points at how to get one rather than only saying it is absent.
    expect(problem?.message).toContain('credential-otp');
  });

  it('refuses an emailCode sent alongside a backup code', () => {
    // Not tidiness: accepting it would let a caller burn a live emailed code on a
    // request that never checks it, invalidating a code the user may be part-way
    // through using elsewhere.
    const result = resolveDisablePath(proofs(['backupCode'], '000000'));

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.problems.map((p) => p.path)).toEqual(['emailCode']);
  });

  it('accepts a backup code on its own', () => {
    const result = resolveDisablePath(proofs(['backupCode']));
    expect(result.ok).toBe(true);
    expect(result.ok && result.path).toBe('backup-code');
  });
});
