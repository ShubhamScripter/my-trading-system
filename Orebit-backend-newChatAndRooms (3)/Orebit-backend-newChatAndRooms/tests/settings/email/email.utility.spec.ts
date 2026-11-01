import { describe, expect, it } from 'vitest';
import {
  EMAIL_CHANGE_METHODS,
  PROOF_FIELD_BY_METHOD,
  canSkipRetained,
  type EmailChangeAccount,
  type EmailChangeGrant,
  type EmailChangeProofField,
  type EmailRecoveryGrant,
} from '../../../src/settings/email/email.types';
import {
  maskEmail,
  methodAllowed,
  methodsFor,
  parseChangeGrant,
  parseRecoveryGrant,
  resolveEmailChangeProof,
  serialiseGrant,
} from '../../../src/settings/email/email.utility';

/**
 * ═══ THE EMAIL-CHANGE POLICY IS A TABLE, SO IT IS TESTED AS ONE ═════════════
 *
 * Four pure rules, and three of them are ordering rules whose failure mode is silent.
 *
 * `methodsFor` decides which security tier an account must use, and the tiers are ranked
 * by strength. The dangerous bug is not refusing a tier that should work — a user
 * notices that immediately — it is OFFERING a weak tier alongside a strong one, which
 * nobody notices and which makes the strong tiers documentation. So the tests below
 * assert the withholding, not just the offering.
 *
 * `resolveEmailChangeProof` decides which proof a declared tier accepts. A version that
 * tried each proof in turn would collapse five ordered tiers into one OR whose weakest
 * member decides, so every (tier, wrong proof) pair is enumerated rather than sampled.
 *
 * `parseChangeGrant` / `parseRecoveryGrant` are the boundary where a cache value becomes
 * an authorisation. Every way they can be malformed must produce `null`, because `null`
 * is what the caller already treats as "refuse" — a throw would be a 500 on a path whose
 * honest answer is "start again".
 *
 * Pure, so none of this needs a container, a database or a Redis.
 */

// ─── maskEmail ──────────────────────────────────────────────────────────────

describe('masking an address', () => {
  it('keeps the first and last character of the local part', () => {
    expect(maskEmail('ada.lovelace@example.test')).toBe('a***e@example.test');
  });

  it('keeps the domain whole, because that is what makes it recognisable', () => {
    // Masking the domain would leave a string nobody can identify as their own, which
    // defeats the purpose of showing it at all.
    expect(maskEmail('someone@mail.example.co.uk')).toBe('s***e@mail.example.co.uk');
  });

  it.each(['ab@x.com', 'a@x.com', 'abc@x.com'])(
    'reveals nothing at all from a short local part (%s)',
    (email) => {
      // `a***b` on a two-character local part would disclose both characters there are.
      // The rule is deliberately most conservative where a mask leaks proportionally
      // most.
      const masked = maskEmail(email);
      expect(masked.startsWith('***@')).toBe(true);
    },
  );

  it('never returns the input unchanged', () => {
    for (const email of ['ada@example.test', 'ab@x.com', 'a.very.long.address@example.test']) {
      expect(maskEmail(email)).not.toBe(email);
    }
  });

  it('masks wholesale rather than passing through something it cannot parse', () => {
    // A caller has already made a mistake; leaking the value is the worse of the two
    // ways to react to that.
    expect(maskEmail('not-an-address')).toBe('***');
    expect(maskEmail('@leading')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });

  it('uses the LAST @, so a local part containing one is masked correctly', () => {
    expect(maskEmail('"odd@name"@example.test')).toBe('"***"@example.test');
  });
});

// ─── the security tiers ─────────────────────────────────────────────────────

function account(overrides: Partial<EmailChangeAccount> = {}): EmailChangeAccount {
  return {
    passkeyEnabled: false,
    totpEnrolled: false,
    kycVerified: false,
    hasPassword: false,
    ...overrides,
  };
}

describe('which security tier an account must use', () => {
  it('offers every strong tier it has, so a user can reach for whichever is to hand', () => {
    const all = methodsFor(
      account({ totpEnrolled: true, passkeyEnabled: true, kycVerified: true }),
    );
    expect(all).toEqual(['authenticator', 'passkey', 'kyc']);
  });

  it.each([
    ['authenticator', { totpEnrolled: true }],
    ['passkey', { passkeyEnabled: true }],
    ['kyc', { kycVerified: true }],
  ] as const)('offers "%s" alone when it is the only strong tier', (method, state) => {
    expect(methodsFor(account(state))).toEqual([method]);
  });

  // ═══ THE ASSERTIONS THAT MATTER ═════════════════════════════════════════════
  //
  // A permissive bug here is invisible: every client would take the easy branch and the
  // strong tiers would never run.

  it.each([
    ['an authenticator', { totpEnrolled: true }],
    ['a passkey', { passkeyEnabled: true }],
    ['KYC', { kycVerified: true }],
  ] as const)('WITHHOLDS the password when the account has %s', (_label, state) => {
    const offered = methodsFor(account({ ...state, hasPassword: true }));
    expect(offered).not.toContain('password');
    expect(offered).not.toContain('none');
  });

  it('falls back to the password only when no strong tier exists', () => {
    expect(methodsFor(account({ hasPassword: true }))).toEqual(['password']);
  });

  it('falls back to nothing when there is no password either', () => {
    // Not a hole. This account's two emailed codes ARE the strongest proof obtainable,
    // and refusing the change would strand a user on an address they may have lost.
    expect(methodsFor(account())).toEqual(['none']);
  });

  it('never offers "none" alongside anything else', () => {
    const states = [
      { totpEnrolled: true },
      { passkeyEnabled: true },
      { kycVerified: true },
      { hasPassword: true },
    ];
    for (const state of states) {
      const offered = methodsFor(account(state));
      expect(offered.includes('none') && offered.length > 1).toBe(false);
    }
  });
});

describe('whether a declared tier is allowed', () => {
  it('refuses a tier the account cannot use at all', () => {
    expect(methodAllowed('passkey', account({ hasPassword: true }))).toBe(false);
  });

  it('refuses the password when something stronger exists, even though it IS available', () => {
    // The distinction `methodAllowed` exists to draw: the account genuinely has a
    // password, and the tier is still not one it may name.
    const withBoth = account({ passkeyEnabled: true, hasPassword: true });
    expect(methodAllowed('password', withBoth)).toBe(false);
    expect(methodAllowed('passkey', withBoth)).toBe(true);
  });

  it('refuses "none" on an account that has a password', () => {
    expect(methodAllowed('none', account({ hasPassword: true }))).toBe(false);
  });

  it('allows "none" only when nothing at all is configured', () => {
    expect(methodAllowed('none', account())).toBe(true);
  });
});

describe('which tiers may stand in for an unreachable retained mailbox', () => {
  it.each(['authenticator', 'passkey', 'kyc'] as const)('allows "%s"', (method) => {
    expect(canSkipRetained(method)).toBe(true);
  });

  it.each(['password', 'none'] as const)('refuses "%s"', (method) => {
    // On an account whose only proof is a password, an attacker holding that password
    // could otherwise shed the very record the real owner needs to recover.
    expect(canSkipRetained(method)).toBe(false);
  });
});

// ─── resolveEmailChangeProof ────────────────────────────────────────────────

const SAMPLE: Readonly<Record<EmailChangeProofField, unknown>> = {
  totpCode: '123456',
  passkey: { id: 'credential-id' },
  kyc: { reference: 'provider-handle' },
  password: 'correct horse battery staple',
};

const PROVEN_METHODS = ['authenticator', 'passkey', 'kyc', 'password'] as const;

function request(
  method: string,
  fields: readonly EmailChangeProofField[],
): Parameters<typeof resolveEmailChangeProof>[0] {
  const built: Record<string, unknown> = { method };
  for (const field of fields) built[field] = SAMPLE[field];
  return built as unknown as Parameters<typeof resolveEmailChangeProof>[0];
}

describe('each tier and its own proof', () => {
  it.each(PROVEN_METHODS.map((m) => [m, PROOF_FIELD_BY_METHOD[m]] as const))(
    '"%s" is proved by "%s"',
    (method, field) => {
      const result = resolveEmailChangeProof(request(method, [field]));
      expect(result.ok).toBe(true);
      expect(result.ok && result.method).toBe(method);
    },
  );

  it('"none" is satisfied by carrying nothing', () => {
    const result = resolveEmailChangeProof(request('none', []));
    expect(result.ok).toBe(true);
  });

  it('rejects a tier this build does not know', () => {
    const result = resolveEmailChangeProof(request('sms', []));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems[0]?.path).toBe('method');
  });

  it('never reads a proof VALUE, only its presence', () => {
    // Verifying a passkey assertion or a TOTP code belongs to the mechanisms; a resolver
    // that inspected them would be a second place those rules live.
    const result = resolveEmailChangeProof({ method: 'passkey', passkey: { nonsense: true } });
    expect(result.ok).toBe(true);
  });
});

describe('a proof that does not match the declared tier', () => {
  const MISMATCHES = PROVEN_METHODS.flatMap((method) =>
    (['totpCode', 'passkey', 'kyc', 'password'] as const)
      .filter((field) => field !== PROOF_FIELD_BY_METHOD[method])
      .map((field) => [method, field] as const),
  );

  it.each(MISMATCHES)('"%s" refuses a request carrying only "%s"', (method, wrong) => {
    expect(resolveEmailChangeProof(request(method, [wrong])).ok).toBe(false);
  });

  it.each(MISMATCHES)(
    '"%s" refuses its OWN proof alongside "%s" rather than ignoring the extra',
    (method, wrong) => {
      // The security-relevant half. `.strict()` catches this at the door, but the
      // resolver runs again inside the service where no schema stands in front of it,
      // and "extra proofs are ignored" is how ordered tiers collapse into one OR.
      const result = resolveEmailChangeProof(
        request(method, [PROOF_FIELD_BY_METHOD[method], wrong]),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.problems.map((p) => p.path)).toEqual([wrong]);
    },
  );

  it('refuses a downgrade dressed as a stronger request', () => {
    // The shape an attacker would send: name the tier the server expects, attach the
    // weak proof as well, and hope the server tries both.
    const result = resolveEmailChangeProof({
      method: 'passkey',
      passkey: { id: 'x' },
      password: 'guess',
    });
    expect(result.ok).toBe(false);
  });

  it.each(PROVEN_METHODS)('"%s" refuses a request with no proof at all', (method) => {
    const result = resolveEmailChangeProof(request(method, []));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems[0]?.path).toBe(PROOF_FIELD_BY_METHOD[method]);
  });

  it.each(['totpCode', 'passkey', 'kyc', 'password'] as const)(
    '"none" refuses a stray "%s"',
    (field) => {
      // The one case where the resolver's answer and the service's behaviour could
      // otherwise disagree: the service would ignore it, and the caller would believe
      // it had been checked.
      expect(resolveEmailChangeProof(request('none', [field])).ok).toBe(false);
    },
  );

  it('names every conflicting field when more than one is sent', () => {
    const result = resolveEmailChangeProof({
      method: 'authenticator',
      totpCode: '123456',
      password: 'x',
      passkey: { id: 'y' },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.map((p) => p.path).sort()).toEqual([
      'passkey',
      'password',
    ]);
  });
});

// ─── the grants ─────────────────────────────────────────────────────────────

const CHANGE_GRANT: EmailChangeGrant = {
  challengeId: 'ch-1',
  userId: '01940000-0000-7000-8000-000000000001',
  familyId: '01940000-0000-7000-8000-00000000fa11',
  newEmail: 'New.Address@example.test',
  newEmailLower: 'new.address@example.test',
  method: 'passkey',
  requiredTargets: ['current', 'new'],
  retainedEmailLower: null,
  skippedRetained: false,
};

const RECOVERY_GRANT: EmailRecoveryGrant = {
  challengeId: 'rc-1',
  retainedEmailId: '01940000-0000-7000-8000-0000000000d1',
  userId: '01940000-0000-7000-8000-000000000001',
  intent: 'restore',
  targetEmail: 'Old.Address@example.test',
  targetEmailLower: 'old.address@example.test',
  reportedCompromise: true,
};

describe('an in-flight change, out to the cache and back', () => {
  it('round-trips every field', () => {
    expect(parseChangeGrant(serialiseGrant(CHANGE_GRANT))).toEqual(CHANGE_GRANT);
  });

  it('round-trips the three-mailbox form', () => {
    const withRetained: EmailChangeGrant = {
      ...CHANGE_GRANT,
      requiredTargets: ['current', 'new', 'retained'],
      retainedEmailLower: 'old.address@example.test',
    };
    expect(parseChangeGrant(serialiseGrant(withRetained))).toEqual(withRetained);
  });

  it.each(EMAIL_CHANGE_METHODS)('round-trips the "%s" tier', (method) => {
    expect(parseChangeGrant(serialiseGrant({ ...CHANGE_GRANT, method }))?.method).toBe(method);
  });

  it.each([
    ['a missing key', null],
    ['not JSON at all', 'definitely-not-json'],
    ['JSON that is not an object', '"a string"'],
    ['JSON null', 'null'],
    ['an array', '[]'],
  ])('reads %s as null rather than throwing', (_label, raw) => {
    expect(parseChangeGrant(raw)).toBeNull();
  });

  it.each([
    'challengeId',
    'userId',
    'familyId',
    'newEmail',
    'newEmailLower',
    'method',
  ])('reads a grant missing %s as null', (field) => {
    const partial: Record<string, unknown> = { ...CHANGE_GRANT };
    delete partial[field];
    expect(parseChangeGrant(JSON.stringify(partial))).toBeNull();
  });

  it.each([
    ['an unknown tier', { method: 'sms' }],
    ['an empty userId', { userId: '' }],
    ['a non-string newEmail', { newEmail: 42 }],
    ['no required targets', { requiredTargets: [] }],
    ['a target this build does not know', { requiredTargets: ['current', 'sms'] }],
    ['targets that are not an array', { requiredTargets: 'current' }],
  ])('reads %s as null', (_label, override) => {
    expect(parseChangeGrant(JSON.stringify({ ...CHANGE_GRANT, ...override }))).toBeNull();
  });

  it('treats a missing skippedRetained as false rather than as truthy', () => {
    const partial: Record<string, unknown> = { ...CHANGE_GRANT };
    delete partial.skippedRetained;
    expect(parseChangeGrant(JSON.stringify(partial))?.skippedRetained).toBe(false);
  });

  it('does not read a truthy non-boolean as a skip', () => {
    // `skippedRetained` decides whether a whole mailbox proof is waived, so it must be
    // exactly `true` and never merely truthy.
    const forged = JSON.stringify({ ...CHANGE_GRANT, skippedRetained: 'yes' });
    expect(parseChangeGrant(forged)?.skippedRetained).toBe(false);
  });
});

describe('an in-flight recovery, out to the cache and back', () => {
  it('round-trips every field', () => {
    expect(parseRecoveryGrant(serialiseGrant(RECOVERY_GRANT))).toEqual(RECOVERY_GRANT);
  });

  it.each(['restore', 'replace'] as const)('round-trips the "%s" intent', (intent) => {
    expect(parseRecoveryGrant(serialiseGrant({ ...RECOVERY_GRANT, intent }))?.intent).toBe(
      intent,
    );
  });

  it.each([
    ['an unknown intent', { intent: 'delete' }],
    ['an empty retainedEmailId', { retainedEmailId: '' }],
    ['an empty target', { targetEmailLower: '' }],
    ['a non-string userId', { userId: 7 }],
  ])('reads %s as null', (_label, override) => {
    expect(parseRecoveryGrant(JSON.stringify({ ...RECOVERY_GRANT, ...override }))).toBeNull();
  });

  it('does not read a truthy non-boolean as a compromise report', () => {
    const forged = JSON.stringify({ ...RECOVERY_GRANT, reportedCompromise: 1 });
    expect(parseRecoveryGrant(forged)?.reportedCompromise).toBe(false);
  });

  it('does not accept a change grant as a recovery grant', () => {
    // The two share a cache key. A change grant read as a recovery would be an
    // authorisation for an operation nobody proved.
    expect(parseRecoveryGrant(serialiseGrant(CHANGE_GRANT))).toBeNull();
  });

  it('does not accept a recovery grant as a change grant', () => {
    expect(parseChangeGrant(serialiseGrant(RECOVERY_GRANT))).toBeNull();
  });
});
