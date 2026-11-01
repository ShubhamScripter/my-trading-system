import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SECURITY_COOLDOWN } from '../../../auth/auth.constants';
import type { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { RecentSecurityChangePolicy } from '../../../auth/services/recent-security-change.policy';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';

/**
 * The one collaborator five services ask, and specifically the two properties that
 * make it a SECURITY control rather than a convenience:
 *
 *   it reads the account, and
 *   it reads nothing else.
 *
 * The second is what "session independence" actually means in code. A freeze that
 * consulted a session, a token claim or a Redis key would evaporate on logout, on a new
 * login, or on a cache flush — and the attacker this exists to stop has just caused
 * every session to be revoked, so they arrive holding a brand new one.
 */

const USER_ID = '01940000-0000-7000-8000-000000000001';
const WINDOW_MS = SECURITY_COOLDOWN.AFTER_EMAIL_CHANGE_SECONDS * 1000;

let findEmailChangedAt: ReturnType<typeof vi.fn>;
let policy: RecentSecurityChangePolicy;

beforeEach(() => {
  findEmailChangedAt = vi.fn().mockResolvedValue(null);
  policy = new RecentSecurityChangePolicy(
    { findEmailChangedAt } as unknown as UserDbOperation,
  );
});

async function refusal(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

describe('assertNoRecentEmailChange', () => {
  it('permits an account whose address has never moved', async () => {
    await expect(policy.assertNoRecentEmailChange(USER_ID)).resolves.toBeUndefined();
  });

  it('refuses while the window is open', async () => {
    findEmailChangedAt.mockResolvedValue(new Date());

    const problem = await refusal(policy.assertNoRecentEmailChange(USER_ID));
    expect(problem.type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('permits once the window has closed', async () => {
    findEmailChangedAt.mockResolvedValue(new Date(Date.now() - WINDOW_MS - 1000));

    await expect(policy.assertNoRecentEmailChange(USER_ID)).resolves.toBeUndefined();
  });

  it('permits an account it cannot find, leaving that refusal to the caller', async () => {
    // Deliberate. Every caller independently resolves the account and answers
    // `unauthenticated` for one that is gone; a second, differently-worded refusal here
    // would put an authentication decision inside a policy that is not about
    // authentication — and one whose slug tells the caller to wait 24 hours for an
    // account that will never come back.
    findEmailChangedAt.mockResolvedValue(null);

    await expect(policy.assertNoRecentEmailChange(USER_ID)).resolves.toBeUndefined();
  });
});

describe('the state it reads is the ACCOUNT, which is what survives a logout', () => {
  it('is keyed on the user id and takes nothing else', async () => {
    await policy.assertNoRecentEmailChange(USER_ID);

    // One argument, and it is the account. There is no session id, no device id, no
    // access token and no cache key in this signature — so there is nothing for
    // logging out, signing in again, switching device or flushing Redis to change.
    expect(findEmailChangedAt).toHaveBeenCalledWith(USER_ID);
    expect(findEmailChangedAt.mock.calls[0]).toHaveLength(1);
  });

  it('answers identically across repeated calls that stand in for separate sessions', async () => {
    const changedAt = new Date();
    findEmailChangedAt.mockResolvedValue(changedAt);

    // Three calls with nothing shared between them but the user id — which is exactly
    // what "the same account from a different device, after a fresh login" looks like
    // at this layer. All three are refused.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const problem = await refusal(policy.assertNoRecentEmailChange(USER_ID));
      expect(problem.type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
    }

    // And it re-read every time rather than caching the first verdict in the instance,
    // which is what lets the freeze end on its own without a restart.
    expect(findEmailChangedAt).toHaveBeenCalledTimes(3);
  });
});
