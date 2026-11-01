import { describe, expect, it } from 'vitest';
import {
  mayDeleteWithFunds,
  resolveDeleteProof,
  shouldPromptWithdrawal,
} from '../../../src/settings/delete-account/delete-account.utility';
import type { PendingWithdrawalsState } from '../../../src/settings/delete-account/delete-account.types';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * Two decision tables, and the interesting behaviour of both is what they REFUSE.
 *
 * `resolveDeleteProof` is the four-case enrolment table. Three of its four cases are
 * ways a legitimate owner could be locked out of deleting their own account, so most
 * of what is asserted below is what is NOT demanded — in particular, that the account
 * password is never a route to a deletion.
 *
 * The withdrawal helpers exist almost entirely to stop `unavailable` being treated as
 * `none`. That is the single mistake this boundary is shaped to prevent, so it gets
 * its own assertions rather than being covered incidentally.
 */

const NEITHER = { hasTotp: false, hasPasskey: false };
const TOTP_ONLY = { hasTotp: true, hasPasskey: false };
const PASSKEY_ONLY = { hasTotp: false, hasPasskey: true };
const BOTH = { hasTotp: true, hasPasskey: true };

const PASSKEY = { id: 'credential-1' };

describe('resolveDeleteProof — the four-case enrolment table', () => {
  it('takes a TOTP code when only an authenticator is enrolled', () => {
    expect(resolveDeleteProof({ totpCode: '123456' }, TOTP_ONLY)).toEqual({
      ok: true,
      method: 'totp',
    });
  });

  it('takes an assertion when only a passkey is enrolled', () => {
    expect(resolveDeleteProof({ passkey: PASSKEY }, PASSKEY_ONLY)).toEqual({
      ok: true,
      method: 'passkey',
    });
  });

  it('takes either when both are enrolled', () => {
    expect(resolveDeleteProof({ totpCode: '123456' }, BOTH)).toEqual({ ok: true, method: 'totp' });
    expect(resolveDeleteProof({ passkey: PASSKEY }, BOTH)).toEqual({ ok: true, method: 'passkey' });
  });

  it('takes the emailed code alone when nothing is enrolled', () => {
    // The case worth the most scrutiny. `reauthVerify` answers this same question by
    // falling back to the account PASSWORD, which would be wrong twice here: it is not
    // what the ceremony promises, and an account created through a provider has no
    // credential row at all — so it would make deletion impossible for exactly the
    // people who cannot supply a password.
    expect(resolveDeleteProof({}, NEITHER)).toEqual({ ok: true, method: 'none' });
  });

  it('refuses a factor the account does not hold, naming which', () => {
    const totp = resolveDeleteProof({ totpCode: '123456' }, PASSKEY_ONLY);
    expect(totp.ok).toBe(false);
    expect(totp.ok === false && totp.message).toMatch(/authenticator/i);

    const passkey = resolveDeleteProof({ passkey: PASSKEY }, TOTP_ONLY);
    expect(passkey.ok).toBe(false);
    expect(passkey.ok === false && passkey.message).toMatch(/biometric/i);
  });

  it('refuses a factor sent against an account with nothing enrolled', () => {
    // Not "anything goes". Accepting a TOTP code against an account with no
    // authenticator would tell a client its proof was checked when nothing checked it.
    expect(resolveDeleteProof({ totpCode: '123456' }, NEITHER).ok).toBe(false);
    expect(resolveDeleteProof({ passkey: PASSKEY }, NEITHER).ok).toBe(false);
  });

  it('refuses both factors at once rather than picking one', () => {
    // Ambiguity is an error, not a preference: a body carrying both would otherwise
    // silently exercise whichever branch comes first, so the caller could not tell
    // which credential was spent.
    const both = resolveDeleteProof({ totpCode: '123456', passkey: PASSKEY }, BOTH);
    expect(both.ok).toBe(false);
    expect(both.ok === false && both.message).toMatch(/exactly one/i);
  });

  it('refuses an empty body when a factor is enrolled', () => {
    expect(resolveDeleteProof({}, TOTP_ONLY).ok).toBe(false);
    expect(resolveDeleteProof({}, PASSKEY_ONLY).ok).toBe(false);
    expect(resolveDeleteProof({}, BOTH).ok).toBe(false);
  });

  it('reports the missing factor before complaining that nothing was sent', () => {
    // Ordering: a caller naming an absent factor is told which one is missing rather
    // than told to send a factor they just sent.
    const resolved = resolveDeleteProof({ totpCode: '123456' }, PASSKEY_ONLY);
    expect(resolved.ok === false && resolved.message).not.toMatch(/Send the code/);
  });

  it('never resolves to a method naming the account password', () => {
    // The exhaustive version of the case-4 assertion: across every combination of
    // inputs and enrolments, the only methods this table can return are the two real
    // factors and `none`. There is no arrangement that asks for a password.
    const inputs = [{}, { totpCode: '1' }, { passkey: PASSKEY }, { totpCode: '1', passkey: PASSKEY }];
    const enrolments = [NEITHER, TOTP_ONLY, PASSKEY_ONLY, BOTH];

    for (const input of inputs) {
      for (const enrolled of enrolments) {
        const resolved = resolveDeleteProof(input, enrolled);
        if (resolved.ok) expect(['totp', 'passkey', 'none']).toContain(resolved.method);
      }
    }
  });
});

describe('the withdrawal boundary — `unavailable` is not `none`', () => {
  const UNAVAILABLE: PendingWithdrawalsState = { state: 'unavailable' };
  const NONE: PendingWithdrawalsState = { state: 'none' };
  const PENDING: PendingWithdrawalsState = { state: 'pending' };

  it('prompts only when a real provider reported funds', () => {
    expect(shouldPromptWithdrawal(PENDING)).toBe(true);
    expect(shouldPromptWithdrawal(NONE)).toBe(false);
  });

  it('does not prompt when no subsystem is bound', () => {
    // False here means "do not render a prompt", NOT "this account has no funds" —
    // which is why the raw state travels to the client beside this boolean rather than
    // being collapsed into it. A prompt offering to withdraw through an API that does
    // not exist would be worse than no prompt.
    expect(shouldPromptWithdrawal(UNAVAILABLE)).toBe(false);
  });

  it('lets a deletion proceed when no subsystem is bound', () => {
    // An unbuilt subsystem must not make the feature unusable. Refusing here would
    // mean no account could ever be deleted until a wallet shipped.
    expect(mayDeleteWithFunds(UNAVAILABLE, false)).toBe(true);
    expect(mayDeleteWithFunds(UNAVAILABLE, true)).toBe(true);
  });

  it('lets a deletion proceed when a provider found nothing', () => {
    expect(mayDeleteWithFunds(NONE, false)).toBe(true);
  });

  it('refuses a deletion with pending funds unless acknowledged', () => {
    expect(mayDeleteWithFunds(PENDING, false)).toBe(false);
    expect(mayDeleteWithFunds(PENDING, true)).toBe(true);
  });

  it('treats `unavailable` and `none` differently nowhere except where it must', () => {
    // The two agree on both helpers today, which is exactly why the distinction has to
    // be carried in the TYPE rather than inferred from behaviour: a future caller that
    // needs to tell them apart — a real wallet reporting an outage, say — must still be
    // able to, and would not be if the port had collapsed them into a boolean.
    expect(shouldPromptWithdrawal(UNAVAILABLE)).toBe(shouldPromptWithdrawal(NONE));
    expect(mayDeleteWithFunds(UNAVAILABLE, false)).toBe(mayDeleteWithFunds(NONE, false));
    expect(UNAVAILABLE.state).not.toBe(NONE.state);
  });
});
