import { beforeEach, describe, expect, it, vi } from 'vitest';
import { policy } from '../../../auth/limits';
import { KEYS } from '../../../redis';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { AntiPhishingService } from '../../../src/settings/antiPhishing/antiPhishing.service';
import {
  openAntiPhishingCode,
  sealAntiPhishingCode,
} from '../../../src/settings/antiPhishing/antiPhishing.utility';
import type { SealedValue } from '../../../src/utils/sealed-secret';
import { makePrincipal, makeSecurityChangePolicy, makeUser } from '../../harness';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * An anti-phishing code is not a credential — it authorises nothing — so the questions
 * worth asking of this service are not the ones a Payment PIN spec asks. They are:
 *
 *   1. Does the right value actually get written, sealed, and bound to the account?
 *   2. Is every refusal the server could issue for free issued BEFORE the user's
 *      emailed code is spent? A user who mistypes a field must not have to request
 *      another email.
 *   3. Can `set` ever overwrite an existing code, under any interleaving?
 *   4. Is the code kept out of every response, every log line, and every other
 *      account's mail?
 *
 * Assertions are phrased as OBSERVABLE OUTCOMES rather than as calls to collaborators:
 * was the row actually written, was the emailed code actually consumed, was the quota
 * actually charged — and, most of the file, was the code left UNSPENT when the request
 * was going to be refused anyway.
 *
 * Limits are read through `policy()` rather than transcribed, so a founder changing a
 * number does not change this file.
 *
 * ─── On the doubles ─────────────────────────────────────────────────────────
 *
 * `users` is a stateful object holding the four sealed columns, because the ORDER of
 * "check then write" and the compare-and-swap on the write are the properties most of
 * these tests are about — a stub returning fixed values could not express a race.
 * Sealing is REAL: `sealAntiPhishingCode` and `openAntiPhishingCode` are the production
 * functions, so "the stored value is not the plaintext" and "it opens to the code the
 * caller sent" are both genuinely asserted rather than modelled.
 */

const USER = makeUser();
const PRINCIPAL = makePrincipal({ userId: USER.id });
const IP_CLASS = '203.0.113.0/24';
const EMAIL_CODE = '123456';

const OLD_CODE = 'Old1815';
const NEW_CODE = 'Ada1815';

/**
 * The `users` double: the four columns as one nullable envelope, plus the two
 * compare-and-swap writes and the `findById` the notification uses.
 *
 * `setAntiPhishingIfAbsent` and `replaceAntiPhishing` return booleans decided by the
 * CURRENT state, which is what makes them a real CAS rather than a recorded call — the
 * concurrency tests below drive both through interleavings.
 */
function createUsers(initial: SealedValue | null = null) {
  const state: { sealed: SealedValue | null } = { sealed: initial };

  return {
    state,
    findAntiPhishing: vi.fn(async () => state.sealed),
    setAntiPhishingIfAbsent: vi.fn(async (_userId: string, sealed: SealedValue) => {
      if (state.sealed !== null) return false;
      state.sealed = sealed;
      return true;
    }),
    replaceAntiPhishing: vi.fn(async (_userId: string, sealed: SealedValue) => {
      if (state.sealed === null) return false;
      state.sealed = sealed;
      return true;
    }),
    findById: vi.fn(async () => ({
      ...USER,
      antiPhishingCiphertext: state.sealed?.ciphertext ?? null,
      antiPhishingIv: state.sealed?.iv ?? null,
      antiPhishingTag: state.sealed?.tag ?? null,
      antiPhishingKeyVersion: state.sealed?.keyVersion ?? null,
    })),
  };
}

/** A real `Map`, so a charge that was consumed is observably consumed. */
function createCache() {
  const counts = new Map<string, number>();
  return {
    counts,
    consume: vi.fn(async (key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }),
  };
}

function createTwoFactor() {
  return { consumeCredentialOtp: vi.fn(async () => undefined) };
}

describe('AntiPhishingService', () => {
  let users: ReturnType<typeof createUsers>;
  let cache: ReturnType<typeof createCache>;
  let twoFactor: ReturnType<typeof createTwoFactor>;
  let mail: { sendSecurityChanged: ReturnType<typeof vi.fn> };
  let securityChanges: ReturnType<typeof makeSecurityChangePolicy>;

  function build(): AntiPhishingService {
    return new AntiPhishingService(
      twoFactor as never,
      users as never,
      cache as never,
      mail as never,
      securityChanges as never,
    );
  }

  /** Seal a code for the fixture account, as the database would hold it. */
  const stored = (code: string): SealedValue => sealAntiPhishingCode(code, USER.id);

  /** What the row now holds, in plaintext. */
  const readBack = (): string | null =>
    users.state.sealed === null ? null : openAntiPhishingCode(users.state.sealed, USER.id);

  beforeEach(() => {
    users = createUsers();
    cache = createCache();
    twoFactor = createTwoFactor();
    mail = { sendSecurityChanged: vi.fn() };
    securityChanges = makeSecurityChangePolicy();
  });

  // ─── status ───────────────────────────────────────────────────────────────

  describe('status', () => {
    it('reports not configured when no code is set', async () => {
      expect(await build().status(USER.id)).toEqual({ configured: false });
    });

    it('reports configured when one is set', async () => {
      users = createUsers(stored(OLD_CODE));

      expect(await build().status(USER.id)).toEqual({ configured: true });
    });

    it('returns ONLY the boolean — never the code', async () => {
      users = createUsers(stored(OLD_CODE));

      const status = await build().status(USER.id);

      // The status shape has exactly one key. An endpoint that returned the code would
      // be the one call an attacker holding a stolen token would make to learn what to
      // forge, and it would add nothing the user's own email does not already give.
      expect(Object.keys(status)).toEqual(['configured']);
      expect(JSON.stringify(status)).not.toContain(OLD_CODE);
    });

    it('does not charge the rate limit — a screen render is not a mutation', async () => {
      await build().status(USER.id);

      expect(cache.consume).not.toHaveBeenCalled();
    });

    it('does not open the envelope, so a bad key cannot break the screen', async () => {
      users = createUsers({ ...stored(OLD_CODE), keyVersion: 99 });

      // Version 99 is not in the ring, so opening would throw. The status path must
      // never touch key material.
      expect(await build().status(USER.id)).toEqual({ configured: true });
    });
  });

  // ─── set ──────────────────────────────────────────────────────────────────

  describe('set', () => {
    const set = (code = NEW_CODE) =>
      build().set(PRINCIPAL, IP_CLASS, { action: 'set', code, emailCode: EMAIL_CODE });

    it('stores the code, sealed, and opens back to what the caller sent', async () => {
      await set();

      expect(readBack()).toBe(NEW_CODE);
    });

    it('never stores the plaintext', async () => {
      await set();

      // The sealed columns must not contain the code as a substring, in any encoding
      // a careless implementation might have reached for.
      const bytes = Buffer.from(users.state.sealed?.ciphertext ?? new Uint8Array());
      expect(bytes.toString('utf8')).not.toContain(NEW_CODE);
      expect(bytes.toString('base64')).not.toContain(Buffer.from(NEW_CODE).toString('base64'));
    });

    it('binds the envelope to this account, so it cannot be reused on another', async () => {
      await set();

      expect(() => openAntiPhishingCode(users.state.sealed as SealedValue, 'somebody-else')).toThrow();
    });

    it('consumes the emailed code', async () => {
      await set();

      expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledWith(USER.id, EMAIL_CODE);
    });

    it('charges the rate limit on entry, on the account key', async () => {
      await set();

      expect(cache.consume).toHaveBeenCalledWith(
        KEYS.rate.antiPhishingUpdateByAccount(USER.id),
        policy().ANTI_PHISHING.UPDATE_BY_ACCOUNT,
        'deny',
      );
    });

    it('asks the security freeze before spending anything', async () => {
      await set();

      expect(securityChanges.assertNoRecentEmailChange).toHaveBeenCalledWith(USER.id);
    });

    it('notifies the owner, and the notification carries the NEW code', async () => {
      await set();
      await new Promise((resolve) => setImmediate(resolve));

      // The first email to carry it. Read back from the row rather than from the
      // request, so a concurrent change means the user is shown what their next email
      // will actually contain.
      expect(mail.sendSecurityChanged).toHaveBeenCalledWith(
        USER.email,
        'anti-phishing code set',
        IP_CLASS,
        NEW_CODE,
      );
    });

    it('refuses when a code is already set, and does NOT overwrite it', async () => {
      users = createUsers(stored(OLD_CODE));

      await expect(set()).rejects.toMatchObject({ type: ERR.ANTI_PHISHING_CODE_ALREADY_SET });
      expect(readBack()).toBe(OLD_CODE);
    });

    it('leaves the emailed code UNSPENT when it refuses an already-set account', async () => {
      // The refusal is free to the server, so it must be free to the user. Otherwise a
      // client bug costs a real person an email round trip.
      users = createUsers(stored(OLD_CODE));

      await expect(set()).rejects.toThrow(ProblemException);
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('leaves the emailed code unspent when the account is frozen', async () => {
      securityChanges.assertNoRecentEmailChange.mockRejectedValue(
        new ProblemException({ type: ERR.SECURITY_CHANGE_COOLDOWN }),
      );

      await expect(set()).rejects.toMatchObject({ type: ERR.SECURITY_CHANGE_COOLDOWN });
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
      expect(users.state.sealed).toBeNull();
    });

    it('leaves the emailed code unspent when the rate limit refuses', async () => {
      cache.consume.mockRejectedValue(new ProblemException({ type: ERR.RATE_LIMITED }));

      await expect(set()).rejects.toMatchObject({ type: ERR.RATE_LIMITED });
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('checks the freeze BEFORE reading the account, so a frozen caller learns nothing', async () => {
      securityChanges.assertNoRecentEmailChange.mockRejectedValue(
        new ProblemException({ type: ERR.SECURITY_CHANGE_COOLDOWN }),
      );

      await expect(set()).rejects.toThrow(ProblemException);
      expect(users.findAntiPhishing).not.toHaveBeenCalled();
    });

    it('writes nothing when the emailed code is rejected', async () => {
      twoFactor.consumeCredentialOtp.mockRejectedValue(
        new ProblemException({ type: ERR.OTP_INVALID }),
      );

      await expect(set()).rejects.toMatchObject({ type: ERR.OTP_INVALID });
      expect(users.setAntiPhishingIfAbsent).not.toHaveBeenCalled();
      expect(users.state.sealed).toBeNull();
    });

    it.each([
      ['expired', ERR.OTP_EXPIRED],
      ['exhausted', ERR.OTP_ATTEMPTS_EXHAUSTED],
      ['replayed', ERR.OTP_INVALID],
    ])('writes nothing when the emailed code is %s', async (_label, type) => {
      twoFactor.consumeCredentialOtp.mockRejectedValue(new ProblemException({ type }));

      await expect(set()).rejects.toMatchObject({ type });
      expect(users.state.sealed).toBeNull();
    });

    // ─── the race ──────────────────────────────────────────────────────────

    it('lets exactly ONE of two concurrent sets win', async () => {
      // ═══ THE PROPERTY THE WRITE PREDICATE EXISTS FOR ══════════════════════
      //
      // Both requests read "no code" — there is no unique index to lose to, because the
      // columns live on a row that always exists — so the ONLY thing standing between
      // them and a silent overwrite is `WHERE ciphertext IS NULL` on the update.
      const service = build();
      const first = service.set(PRINCIPAL, IP_CLASS, {
        action: 'set',
        code: 'First111',
        emailCode: EMAIL_CODE,
      });
      const second = service.set(PRINCIPAL, IP_CLASS, {
        action: 'set',
        code: 'Second22',
        emailCode: EMAIL_CODE,
      });

      const results = await Promise.allSettled([first, second]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ type: ERR.ANTI_PHISHING_CODE_ALREADY_SET });

      // And the winner's value is intact — not a mixture, and not the loser's.
      expect(['First111', 'Second22']).toContain(readBack());
    });

    it('answers a lost race with the same refusal the cheap check would have given', async () => {
      // The stale-precondition path: the read said "absent", the write disagreed. A
      // caller must not be able to tell those apart, because the remedy is identical.
      users.setAntiPhishingIfAbsent.mockResolvedValue(false);

      await expect(set()).rejects.toMatchObject({ type: ERR.ANTI_PHISHING_CODE_ALREADY_SET });
    });

    it('does not notify when the write was refused', async () => {
      users.setAntiPhishingIfAbsent.mockResolvedValue(false);

      await expect(set()).rejects.toThrow(ProblemException);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mail.sendSecurityChanged).not.toHaveBeenCalled();
    });
  });

  // ─── change ───────────────────────────────────────────────────────────────

  describe('change', () => {
    const change = (currentCode = OLD_CODE, code = NEW_CODE) =>
      build().change(PRINCIPAL, IP_CLASS, {
        action: 'change',
        currentCode,
        code,
        emailCode: EMAIL_CODE,
      });

    beforeEach(() => {
      users = createUsers(stored(OLD_CODE));
    });

    it('replaces the code when the current one matches', async () => {
      await change();

      expect(readBack()).toBe(NEW_CODE);
    });

    it('is case-sensitive on the current code', async () => {
      // Case is part of what the user recognises, so it is part of what they must
      // reproduce.
      await expect(change(OLD_CODE.toLowerCase())).rejects.toMatchObject({
        type: ERR.ANTI_PHISHING_CODE_INCORRECT,
      });
    });

    it('refuses a wrong current code and leaves the stored one intact', async () => {
      await expect(change('Wrong111')).rejects.toMatchObject({
        type: ERR.ANTI_PHISHING_CODE_INCORRECT,
      });
      expect(readBack()).toBe(OLD_CODE);
    });

    it('leaves the emailed code UNSPENT on a wrong current code', async () => {
      // ═══ THE ORDERING THIS OPERATION EXISTS TO GET RIGHT ══════════════════
      //
      // `currentCode` is not a security boundary — `replace` reaches the same write
      // without it — so comparing it first costs an attacker nothing, and it saves an
      // honest user from burning an email on a typo.
      await expect(change('Wrong111')).rejects.toThrow(ProblemException);

      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('refuses when no code is configured', async () => {
      users = createUsers(null);

      await expect(change()).rejects.toMatchObject({ type: ERR.ANTI_PHISHING_CODE_NOT_SET });
    });

    it('leaves the emailed code unspent when no code is configured', async () => {
      users = createUsers(null);

      await expect(change()).rejects.toThrow(ProblemException);
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('allows re-setting the same value, rather than refusing it as a reuse', async () => {
      // Unlike a password or a PIN there is no `..._reused` refusal: re-affirming a
      // display string grants nobody anything, and refusing it would be friction for no
      // property.
      await expect(change(OLD_CODE, OLD_CODE)).resolves.toBeUndefined();
      expect(readBack()).toBe(OLD_CODE);
    });

    it('notifies with the new code', async () => {
      await change();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mail.sendSecurityChanged).toHaveBeenCalledWith(
        USER.email,
        'anti-phishing code changed',
        IP_CLASS,
        NEW_CODE,
      );
    });

    it('throws rather than proceeding when the stored envelope cannot be opened', async () => {
      // A `change` that treated an unreadable envelope as "no current code" would
      // compare against nothing. The honest answer is that the database and the key ring
      // disagree — and `replace` is the user's way out, asserted below.
      users = createUsers({ ...stored(OLD_CODE), keyVersion: 99 });

      await expect(change()).rejects.toThrow();
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('is frozen by the security cooldown', async () => {
      securityChanges.assertNoRecentEmailChange.mockRejectedValue(
        new ProblemException({ type: ERR.SECURITY_CHANGE_COOLDOWN }),
      );

      await expect(change()).rejects.toMatchObject({ type: ERR.SECURITY_CHANGE_COOLDOWN });
      expect(readBack()).toBe(OLD_CODE);
    });
  });

  // ─── replace ──────────────────────────────────────────────────────────────

  describe('replace', () => {
    const replace = (code = NEW_CODE) =>
      build().replace(PRINCIPAL, IP_CLASS, { action: 'replace', code, emailCode: EMAIL_CODE });

    beforeEach(() => {
      users = createUsers(stored(OLD_CODE));
    });

    it('replaces the code with no knowledge of the current one', async () => {
      await replace();

      expect(readBack()).toBe(NEW_CODE);
    });

    it('never opens the stored envelope', async () => {
      // ═══ WHY THIS IS THE ESCAPE HATCH ═════════════════════════════════════
      //
      // A row whose key was retired cannot be opened, which blocks `change`. `replace`
      // touches no key material on the read side, so it still works — and its write
      // heals the row onto the active key.
      users = createUsers({ ...stored(OLD_CODE), keyVersion: 99 });

      await expect(replace()).resolves.toBeUndefined();
      expect(readBack()).toBe(NEW_CODE);
    });

    it('demands no passkey, authenticator or password', async () => {
      // The value guards nothing, so demanding a factor would buy no security and would
      // lock every account without one out of a setting it is entitled to change.
      await replace();

      expect(readBack()).toBe(NEW_CODE);
    });

    it('refuses when no code is configured', async () => {
      users = createUsers(null);

      await expect(replace()).rejects.toMatchObject({ type: ERR.ANTI_PHISHING_CODE_NOT_SET });
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('still requires the emailed code', async () => {
      twoFactor.consumeCredentialOtp.mockRejectedValue(
        new ProblemException({ type: ERR.OTP_REQUIRED }),
      );

      await expect(replace()).rejects.toMatchObject({ type: ERR.OTP_REQUIRED });
      expect(readBack()).toBe(OLD_CODE);
    });

    it('is frozen by the security cooldown', async () => {
      securityChanges.assertNoRecentEmailChange.mockRejectedValue(
        new ProblemException({ type: ERR.SECURITY_CHANGE_COOLDOWN }),
      );

      await expect(replace()).rejects.toMatchObject({ type: ERR.SECURITY_CHANGE_COOLDOWN });
      expect(readBack()).toBe(OLD_CODE);
    });

    it('answers a concurrent removal with not-set rather than resurrecting a code', async () => {
      users.replaceAntiPhishing.mockResolvedValue(false);

      await expect(replace()).rejects.toMatchObject({ type: ERR.ANTI_PHISHING_CODE_NOT_SET });
    });

    it('lets both of two concurrent replaces succeed, leaving one of the two values', async () => {
      // Unlike `set`, there is no invariant a second writer can violate: the row already
      // has a code and both requests are entitled to change it. Last write wins, and
      // both callers are told the truth.
      const service = build();
      const results = await Promise.allSettled([
        service.replace(PRINCIPAL, IP_CLASS, {
          action: 'replace',
          code: 'First111',
          emailCode: EMAIL_CODE,
        }),
        service.replace(PRINCIPAL, IP_CLASS, {
          action: 'replace',
          code: 'Second22',
          emailCode: EMAIL_CODE,
        }),
      ]);

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(['First111', 'Second22']).toContain(readBack());
    });
  });

  // ─── the code is not a credential ─────────────────────────────────────────

  describe('the code is not a credential', () => {
    it('exposes no method that verifies the code as a proof of anything', () => {
      // ═══ A STRUCTURAL GUARD ON THE ONE RULE THAT MATTERS ══════════════════
      //
      // The code must never become a credential. The shape that would start that is a
      // method offering to CHECK it for a caller — `verifyCode`, `proveCode`,
      // `authoriseWithCode` — because once one exists, another surface will call it.
      //
      // `change` compares a `currentCode`, and that is deliberately not such a method:
      // it is not callable except as part of a change, and `replace` reaches the same
      // write without it. The comparison exists inside an operation, not as a service
      // anyone can ask for.
      //
      // TypeScript's `private` is erased at runtime, so this reads the real prototype
      // and asserts on the NAMES rather than on visibility.
      const surface = Object.getOwnPropertyNames(AntiPhishingService.prototype).filter(
        (name) => name !== 'constructor',
      );

      const authShaped = surface.filter((name) =>
        /^(verify|prove|authorise|authorize|authenticate|check|login|signIn)/.test(name),
      );

      expect(authShaped).toEqual([]);
      // And the public surface is exactly a read plus the three writes.
      expect(surface).toContain('status');
      expect(surface).toContain('set');
      expect(surface).toContain('change');
      expect(surface).toContain('replace');
    });

    it('never reports the code from any public method', async () => {
      users = createUsers(stored(OLD_CODE));
      const service = build();

      const results = [
        await service.status(USER.id),
        await service.replace(PRINCIPAL, IP_CLASS, {
          action: 'replace',
          code: NEW_CODE,
          emailCode: EMAIL_CODE,
        }),
      ];

      expect(JSON.stringify(results)).not.toContain(OLD_CODE);
      expect(JSON.stringify(results)).not.toContain(NEW_CODE);
    });

    it('takes the account from the principal, never from the request', async () => {
      // No action carries a user id, and nothing here reads one — which is what makes
      // it impossible to change somebody else's code.
      await build().set(PRINCIPAL, IP_CLASS, {
        action: 'set',
        code: NEW_CODE,
        emailCode: EMAIL_CODE,
      });

      for (const call of users.setAntiPhishingIfAbsent.mock.calls) {
        expect(call[0]).toBe(PRINCIPAL.userId);
      }
    });
  });
});
