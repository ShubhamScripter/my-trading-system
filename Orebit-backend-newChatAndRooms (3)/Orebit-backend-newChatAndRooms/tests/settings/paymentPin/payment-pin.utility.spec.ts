import { describe, expect, it } from 'vitest';
import {
  PAYMENT_PIN_METHODS,
  PAYMENT_PIN_OPERATIONS,
  PROOF_FIELD_BY_METHOD,
  type PaymentPinAccount,
  type PaymentPinGrant,
  type PaymentPinProofField,
  type PaymentPinVerificationMethod,
} from '../../../src/settings/paymentPin/payment-pin.types';
import {
  assessPin,
  hasEnrolledFactor,
  methodAvailable,
  methodsFor,
  parseGrant,
  resolvePaymentPinProof,
  serialiseGrant,
} from '../../../src/settings/paymentPin/payment-pin.utility';

/**
 * ═══ THE PAYMENT PIN POLICY IS A TABLE, SO IT IS TESTED AS ONE ══════════════
 *
 * Three pure rules, and the interesting behaviour of all three is what they REFUSE.
 *
 * `resolvePaymentPinProof` decides which credential a request is offering. A test that
 * only walked the three happy paths would pass against an implementation that ignored
 * the declared method and used whichever proof it found first — which is precisely the
 * permissive shape this function exists not to be. So the combinations are enumerated
 * rather than chosen: every method is asserted against every proof field.
 *
 * `assessPin` is the only thing standing between a user and `123456`, over a keyspace
 * small enough that the five guesses `PAYMENT_PIN.VERIFY_BY_ACCOUNT` allows are a real
 * threat. Its rules are asserted by CLASS — every run, every repeated pattern — rather
 * than by spot-checking a few strings, because a rule that happens to catch `123456`
 * and misses `234567` is not the rule.
 *
 * `parseGrant` is the boundary where a Redis value becomes an authorisation. Every way
 * it can be malformed must produce `null`, because `null` is what the caller already
 * treats as "refuse"; a throw would be a 500 on a path whose honest answer is "verify
 * again".
 *
 * Pure, so none of this needs a container, a database or a Redis.
 */

// ─── resolvePaymentPinProof ─────────────────────────────────────────────────

const PROOF_FIELDS = PAYMENT_PIN_METHODS.map(
  (method) => PROOF_FIELD_BY_METHOD[method],
) as readonly PaymentPinProofField[];

/** A syntactically plausible value for each proof field. Nothing here is verified —
 *  the resolver only looks at which fields are PRESENT. */
const SAMPLE: Readonly<Record<PaymentPinProofField, unknown>> = {
  currentPin: '483920',
  totpCode: '123456',
  passkey: { id: 'credential-id' },
};

/**
 * A request naming `method` and carrying `fields`, plus the emailed code.
 *
 * `withoutEmailCode` is a separate builder rather than an optional argument here: a
 * default parameter fires on an explicit `undefined`, so `request(m, f, undefined)`
 * would silently still set the code and the test asserting its absence would be
 * asserting nothing.
 */
function request(
  method: string,
  fields: readonly PaymentPinProofField[],
): Parameters<typeof resolvePaymentPinProof>[0] {
  return { ...withoutEmailCode(method, fields), emailCode: '000000' };
}

function withoutEmailCode(
  method: string,
  fields: readonly PaymentPinProofField[],
): Parameters<typeof resolvePaymentPinProof>[0] {
  const built: Record<string, unknown> = { method };
  for (const field of fields) built[field] = SAMPLE[field];
  return built as unknown as Parameters<typeof resolvePaymentPinProof>[0];
}

describe('the three methods, each with its own proof', () => {
  it.each(PAYMENT_PIN_METHODS.map((m) => [m, PROOF_FIELD_BY_METHOD[m]] as const))(
    '"%s" is proved by "%s"',
    (method, field) => {
      const result = resolvePaymentPinProof(request(method, [field]));

      expect(result.ok).toBe(true);
      expect(result.ok && result.method).toBe(method);
    },
  );

  it('rejects a method this build does not know', () => {
    const result = resolvePaymentPinProof(request('backup-code', []));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems[0]?.path).toBe('method');
  });

  it('never reads the proof VALUE, only its presence', () => {
    // A passkey assertion is verified cryptographically by the library, and a TOTP code
    // against the account's secret. Neither belongs here, and a resolver that inspected
    // them would be a second place those rules live.
    const result = resolvePaymentPinProof({
      method: 'passkey',
      passkey: { nonsense: true },
      emailCode: '000000',
    });

    expect(result.ok).toBe(true);
  });
});

describe('a proof that does not match the declared method', () => {
  /** Every (method, wrong proof field) pair. */
  const MISMATCHES = PAYMENT_PIN_METHODS.flatMap((method) =>
    PROOF_FIELDS.filter((field) => field !== PROOF_FIELD_BY_METHOD[method]).map(
      (field) => [method, field] as const,
    ),
  );

  it.each(MISMATCHES)('"%s" refuses a request carrying "%s"', (method, wrong) => {
    const result = resolvePaymentPinProof(request(method, [wrong]));

    expect(result.ok).toBe(false);
  });

  it.each(MISMATCHES)(
    '"%s" refuses its OWN proof alongside "%s", rather than ignoring the extra',
    (method, wrong) => {
      // The security-relevant half. Zod's `.strict()` catches this at the door, but the
      // resolver runs again inside the service where there is no schema in front of it,
      // and "extra proofs are ignored" is how three methods collapse into one OR.
      const result = resolvePaymentPinProof(
        request(method, [PROOF_FIELD_BY_METHOD[method], wrong]),
      );

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.problems.map((p) => p.path)).toEqual([wrong]);
    },
  );

  it('names every conflicting field when more than one is sent', () => {
    const result = resolvePaymentPinProof({
      method: 'pin',
      currentPin: '483920',
      totpCode: '123456',
      passkey: { id: 'x' },
      emailCode: '000000',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.map((p) => p.path).sort()).toEqual([
      'passkey',
      'totpCode',
    ]);
  });
});

describe('the proofs every method requires', () => {
  it.each(PAYMENT_PIN_METHODS)('"%s" refuses a request with no proof at all', (method) => {
    const result = resolvePaymentPinProof(request(method, []));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems[0]?.path).toBe(
      PROOF_FIELD_BY_METHOD[method],
    );
  });

  it.each(PAYMENT_PIN_METHODS)('"%s" requires the emailed code', (method) => {
    // No exemption for any method, unlike `backup-code` on the disable paths next door:
    // every method here proves something the user currently holds, so none of them is
    // the last way out and none earns a pass on the mailbox round trip.
    const result = resolvePaymentPinProof(
      withoutEmailCode(method, [PROOF_FIELD_BY_METHOD[method]]),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems[0]?.path).toBe('emailCode');
  });
});

// ─── assessPin ──────────────────────────────────────────────────────────────

describe('PIN format', () => {
  it.each([
    ['', 'empty'],
    ['12345', 'five digits'],
    ['1234567', 'seven digits'],
    ['48392a', 'a letter'],
    ['4839 0', 'a space'],
    ['-83920', 'a sign'],
    ['4.8392', 'a decimal point'],
  ])('refuses %s (%s)', (pin) => {
    expect(assessPin(pin).ok).toBe(false);
  });

  it('accepts a PIN with no structure to it', () => {
    expect(assessPin('483920')).toEqual({ ok: true });
  });

  it('accepts a PIN with a leading zero', () => {
    // Would fail if the PIN were ever handled as a number rather than a string.
    expect(assessPin('048392').ok).toBe(true);
  });
});

describe('PIN strength — the rules, asserted by class rather than by example', () => {
  it.each(['000000', '111111', '555555', '999999'])('refuses %s — one digit repeated', (pin) => {
    expect(assessPin(pin).ok).toBe(false);
  });

  it.each(['123456', '234567', '345678', '456789'])('refuses %s — an ascending run', (pin) => {
    expect(assessPin(pin).ok).toBe(false);
  });

  it.each(['654321', '987654', '876543', '543210'])('refuses %s — a descending run', (pin) => {
    expect(assessPin(pin).ok).toBe(false);
  });

  it.each(['121212', '454545', '123123', '789789'])('refuses %s — a repeated motif', (pin) => {
    expect(assessPin(pin).ok).toBe(false);
  });

  it.each(['112233', '445566', '778899'])('refuses %s — repeated pairs', (pin) => {
    expect(assessPin(pin).ok).toBe(false);
  });

  it('refuses a named PIN with no structural rule to catch it', () => {
    // The blocklist earns its keep only on values no rule describes. If this starts
    // failing because a rule now catches it, the entry can go.
    expect(assessPin('696969').ok).toBe(false);
  });

  it('does not treat a wrap-around as a run', () => {
    // `890123` is not what an attacker enumerates, and refusing it would be a rule the
    // error message cannot explain.
    expect(assessPin('890123').ok).toBe(true);
  });

  it.each(['483920', '271828', '314159', '602214', '108642'])('accepts %s', (pin) => {
    expect(assessPin(pin).ok).toBe(true);
  });

  it('explains itself differently for a shape error and a strength error', () => {
    // The two produce different HTTP slugs — `validation_failed` and
    // `payment_pin_weak` — so a screen that showed one message for both would be
    // telling a user with `12345` to pick something less predictable.
    const short = assessPin('12345');
    const weak = assessPin('123456');

    expect(short.ok).toBe(false);
    expect(weak.ok).toBe(false);
    expect(short.ok === false && short.reason).not.toBe(weak.ok === false && weak.reason);
  });
});

// ─── availability ───────────────────────────────────────────────────────────

function account(overrides: Partial<PaymentPinAccount> = {}): PaymentPinAccount {
  return { enabled: false, passkeyEnabled: false, totpEnrolled: false, ...overrides };
}

describe('which methods an account can use', () => {
  it('offers nothing when the PIN is off and no factor exists', () => {
    expect(methodsFor(account())).toEqual([]);
  });

  it('offers "pin" exactly when the PIN is on, because it IS the setting', () => {
    expect(methodAvailable('pin', account({ enabled: false }))).toBe(false);
    expect(methodAvailable('pin', account({ enabled: true }))).toBe(true);
  });

  it('offers "authenticator" only with a confirmed authenticator', () => {
    expect(methodAvailable('authenticator', account({ totpEnrolled: false }))).toBe(false);
    expect(methodAvailable('authenticator', account({ totpEnrolled: true }))).toBe(true);
  });

  it('offers "passkey" only with a passkey', () => {
    expect(methodAvailable('passkey', account({ passkeyEnabled: false }))).toBe(false);
    expect(methodAvailable('passkey', account({ passkeyEnabled: true }))).toBe(true);
  });

  it('offers them in the order a screen should render them, PIN first', () => {
    const all = methodsFor(
      account({ enabled: true, passkeyEnabled: true, totpEnrolled: true }),
    );

    expect(all).toEqual(['pin', 'authenticator', 'passkey']);
  });

  it('still offers "pin" to an account that has lost both factors', () => {
    // The state a user reaches by disabling their authenticator after setting a PIN.
    // Leaving them with no method would strand them with a secret they cannot change.
    expect(methodsFor(account({ enabled: true }))).toEqual(['pin']);
  });
});

describe('whether a PIN may be created at all', () => {
  it('requires a passkey or an authenticator', () => {
    expect(hasEnrolledFactor(account())).toBe(false);
    expect(hasEnrolledFactor(account({ passkeyEnabled: true }))).toBe(true);
    expect(hasEnrolledFactor(account({ totpEnrolled: true }))).toBe(true);
  });
});

// ─── the grant ──────────────────────────────────────────────────────────────

const GRANT: PaymentPinGrant = {
  userId: '01940000-0000-7000-8000-000000000001',
  familyId: '01940000-0000-7000-8000-00000000fa11',
  operation: 'update',
  method: 'passkey',
};

describe('a grant, out to Redis and back', () => {
  it('round-trips every field', () => {
    expect(parseGrant(serialiseGrant(GRANT))).toEqual(GRANT);
  });

  it.each(PAYMENT_PIN_OPERATIONS)('round-trips the "%s" operation', (operation) => {
    expect(parseGrant(serialiseGrant({ ...GRANT, operation }))?.operation).toBe(operation);
  });

  it.each(PAYMENT_PIN_METHODS)('round-trips the "%s" method', (method) => {
    expect(parseGrant(serialiseGrant({ ...GRANT, method }))?.method).toBe(method);
  });

  it.each([
    ['a missing key', null],
    ['not JSON at all', 'definitely-not-json'],
    ['JSON that is not an object', '"a string"'],
    ['JSON null', 'null'],
    ['an array', '[]'],
  ])('reads %s as null rather than throwing', (_label, raw) => {
    expect(parseGrant(raw)).toBeNull();
  });

  it.each([
    ['userId', { ...GRANT, userId: undefined }],
    ['familyId', { ...GRANT, familyId: undefined }],
    ['operation', { ...GRANT, operation: undefined }],
    ['method', { ...GRANT, method: undefined }],
  ])('reads a grant missing %s as null', (_field, partial) => {
    expect(parseGrant(JSON.stringify(partial))).toBeNull();
  });

  it.each([
    ['an empty userId', { ...GRANT, userId: '' }],
    ['an empty familyId', { ...GRANT, familyId: '' }],
    ['a non-string userId', { ...GRANT, userId: 42 }],
    ['an operation this build does not know', { ...GRANT, operation: 'enable' }],
    ['a method this build does not know', { ...GRANT, method: 'backup-code' }],
    ['a method that is a disable path', { ...GRANT, method: 'kyc' }],
  ])('reads %s as null', (_label, malformed) => {
    expect(parseGrant(JSON.stringify(malformed))).toBeNull();
  });

  it('refuses "enable" as an operation, which is what keeps it un-mintable', () => {
    // Enabling is authorised by an emailed code plus factor EXISTENCE, so there is
    // nothing for a challenge to record. A grant claiming it would be an authorisation
    // obtained without proving anything.
    expect(parseGrant(JSON.stringify({ ...GRANT, operation: 'enable' }))).toBeNull();
  });

  it('does not let a leaked grant name a method the caller chose', () => {
    // Belt and braces on the type guard: a grant is only ever written by this service,
    // but it is READ from a store, and a value that parsed with an arbitrary string
    // would flow into an audit line as though the server had recorded it.
    const forged = JSON.stringify({ ...GRANT, method: 'anything' as PaymentPinVerificationMethod });
    expect(parseGrant(forged)).toBeNull();
  });
});
