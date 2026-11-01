import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { PasswordController } from '../../../src/settings/password/password.controller';
import { makePrincipal } from '../../harness';
import { FACTS } from '../../restrictions/double';

/**
 * The controller's whole job is parse → delegate → serialise, so this file asserts
 * exactly three things and nothing about policy:
 *
 *   the acting account comes from the PRINCIPAL and never from the body, which is what
 *   makes it impossible to change somebody else's password through this route;
 *
 *   each action reaches its own service method — a switch that fell through would
 *   return `undefined` and serialise as a 200 for a write that never happened;
 *
 *   the response reports what the SERVER did rather than what the request asked for.
 */

const PRINCIPAL = makePrincipal();
const IP_CLASS = '203.0.113.0/24';

const PASSWORD = { password: 'Nu-Passw0rd!x9', confirmPassword: 'Nu-Passw0rd!x9' };
const EMAIL_CODE = { emailCode: '000000' };

let service: {
  status: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  forgot: ReturnType<typeof vi.fn>;
};
let controller: PasswordController;

/** Narrowed rather than cast: `.catch` yields the union of the resolved and rejected
 *  types, and reading `.type` off that is what tsc refuses. */
async function refusal(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected a ProblemException, but the call resolved');
}

beforeEach(() => {
  service = {
    status: vi.fn(async () => ({
      passwordSet: true,
      set: { available: false, reason: 'A password is already set on this account.' },
      reset: { available: true },
      forgot: { available: true, factorRequired: false, methods: [] },
    })),
    set: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    forgot: vi.fn(async () => ({ factorVerified: null })),
  };

  controller = new PasswordController(service as never);
});

describe('status', () => {
  it('reads the caller’s own account and wraps it in the envelope', async () => {
    const result = await controller.status(PRINCIPAL);

    expect(service.status).toHaveBeenCalledWith(PRINCIPAL.userId);
    expect(result.data).toMatchObject({ outcome: 'password_status', passwordSet: true });
  });
});

describe('mutate — dispatch', () => {
  it('routes `set` to the create flow', async () => {
    const body = { action: 'set', ...PASSWORD, ...EMAIL_CODE };

    const result = await controller.mutate(body, PRINCIPAL, FACTS);

    expect(service.set).toHaveBeenCalledWith(PRINCIPAL, FACTS, expect.objectContaining(body));
    expect(service.reset).not.toHaveBeenCalled();
    expect(service.forgot).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      outcome: 'password_changed',
      operation: 'set',
      factorVerified: null,
      otherSessionsRevoked: true,
    });
  });

  it('routes `reset` to the current-password flow', async () => {
    const body = {
      action: 'reset',
      currentPassword: 'C0rrect-Horse!42',
      ...PASSWORD,
      ...EMAIL_CODE,
    };

    const result = await controller.mutate(body, PRINCIPAL, FACTS);

    expect(service.reset).toHaveBeenCalled();
    expect(service.set).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ operation: 'reset', factorVerified: null });
  });

  it('routes `forgot` and reports the factor the SERVICE proved', async () => {
    // Echoed from the service's return, not from the request, so an integration bug
    // shows up as a mismatch rather than as a confident wrong label.
    service.forgot.mockResolvedValue({ factorVerified: 'passkey' });

    const result = await controller.mutate(
      { action: 'forgot', ...PASSWORD, ...EMAIL_CODE, passkey: { id: 'c' } },
      PRINCIPAL,
      FACTS,
    );

    expect(result.data).toMatchObject({ operation: 'forgot', factorVerified: 'passkey' });
  });

  it('reports `factorVerified: null` for a no-factor `forgot`', async () => {
    const result = await controller.mutate(
      { action: 'forgot', ...PASSWORD, ...EMAIL_CODE },
      PRINCIPAL,
      FACTS,
    );

    expect(result.data).toMatchObject({ factorVerified: null });
  });
});

describe('mutate — what it refuses before reaching the service', () => {
  it('rejects an unknown action rather than falling through the switch', async () => {
    // A fall-through would return `undefined` and serialise as a 200 for a write that
    // never happened, which is the worst available failure mode.
    await expect(
      controller.mutate({ action: 'change', ...PASSWORD }, PRINCIPAL, FACTS),
    ).rejects.toBeInstanceOf(ProblemException);

    expect(service.set).not.toHaveBeenCalled();
    expect(service.reset).not.toHaveBeenCalled();
    expect(service.forgot).not.toHaveBeenCalled();
  });

  it('rejects a mismatched confirmation as validation_failed', async () => {
    const err = await refusal(
      controller.mutate(
        { action: 'set', password: PASSWORD.password, confirmPassword: 'other', ...EMAIL_CODE },
        PRINCIPAL,
        FACTS,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
    // The field is NAMED, so a client can point at the input rather than reprinting
    // the whole form as wrong.
    expect(err.errors?.map((issue) => issue.path)).toContain('confirmPassword');
  });

  it('ignores a `userId` in the body — it is not even a legal field', async () => {
    // The property that makes cross-account changes impossible: no action carries an
    // account identifier, `.strict()` refuses one, and the principal is the only
    // source. Asserted here because this is the layer that chooses between the two.
    await expect(
      controller.mutate(
        { action: 'set', ...PASSWORD, ...EMAIL_CODE, userId: 'someone-else' },
        PRINCIPAL,
        FACTS,
      ),
    ).rejects.toBeInstanceOf(ProblemException);
  });

  it('always passes the principal it was given, never a body value', async () => {
    const other = makePrincipal({ userId: '01940000-0000-7000-8000-0000000000ff' });

    await controller.mutate({ action: 'set', ...PASSWORD, ...EMAIL_CODE }, other, FACTS);

    expect(service.set).toHaveBeenCalledWith(other, FACTS, expect.anything());
  });
});
