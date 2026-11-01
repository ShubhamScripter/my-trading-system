import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../src/http';
import { DeleteAccountController } from '../../../src/settings/delete-account/delete-account.controller';
import { makePrincipal } from '../../harness';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * Three things, as the other settings controller specs do: that dispatch reaches the
 * right service method, that the envelope carries the right `outcome`, and that a
 * malformed body is refused BEFORE any service call.
 *
 * Plus one this controller owes on its own — the public reactivation branch must
 * produce a byte-identical envelope whatever the service found, because the service
 * returns void precisely so there is nothing here to leak.
 */

const PRINCIPAL = makePrincipal();
const IP = '203.0.113.7';
const IP_CLASS = '203.0.113.0/24';
const PURGE_AT = new Date('2026-02-14T10:00:00.000Z');

function createService() {
  return {
    status: vi.fn(async () => ({
      status: 'active' as const,
      purgeAt: null,
      withdrawal: { state: 'unavailable' as const },
      withdrawalPromptRequired: false,
      methods: ['totp'],
    })),
    challenge: vi.fn(async () => ({ methods: ['totp'], options: null })),
    verify: vi.fn(async () => ({
      ticket: 'ticket-1',
      expiresInSeconds: 60,
      action: 'account.delete',
    })),
    remove: vi.fn(async () => ({ purgeAt: PURGE_AT })),
    requestReactivation: vi.fn(async () => undefined),
    reactivate: vi.fn(async () => undefined),
  };
}

function createController(service = createService()) {
  return { controller: new DeleteAccountController(service as never), service };
}

describe('DeleteAccountController.status', () => {
  it('serialises a live account', async () => {
    const { controller } = createController();

    const { data } = await controller.status(PRINCIPAL);

    expect(data).toEqual({
      outcome: 'delete_account_status',
      status: 'active',
      purgeAt: null,
      reactivationAvailableUntil: null,
      withdrawal: { state: 'unavailable' },
      withdrawalPromptRequired: false,
      verification: { methods: ['totp'], emailCodeRequired: true },
    });
  });

  it('reports the deadline under both names, as one instant', async () => {
    const { controller, service } = createController();
    service.status.mockResolvedValue({
      status: 'deleted',
      purgeAt: PURGE_AT,
      withdrawal: { state: 'unavailable' },
      withdrawalPromptRequired: false,
      methods: [],
    } as never);

    const { data } = await controller.status(PRINCIPAL);

    // Derived from one value so the pair cannot disagree.
    expect(data.purgeAt).toBe(PURGE_AT.toISOString());
    expect(data.reactivationAvailableUntil).toBe(data.purgeAt);
  });

  it('passes the withdrawal state through verbatim, without collapsing it', async () => {
    const { controller } = createController();

    const { data } = await controller.status(PRINCIPAL);

    // `unavailable` must reach the client as itself. Collapsing it into the boolean
    // would tell a client the balance is zero when nobody looked.
    expect(data.withdrawal).toEqual({ state: 'unavailable' });
    expect(data.withdrawalPromptRequired).toBe(false);
  });
});

describe('DeleteAccountController.verify', () => {
  it('dispatches the challenge branch', async () => {
    const { controller, service } = createController();

    const { data } = await controller.verify({ action: 'challenge' }, PRINCIPAL);

    expect(service.challenge).toHaveBeenCalledWith(PRINCIPAL.userId);
    expect(data).toEqual({
      outcome: 'delete_account_challenge',
      methods: ['totp'],
      options: null,
      emailCodeRequired: true,
    });
  });

  it('dispatches the verify branch and returns the ticket', async () => {
    const { controller, service } = createController();

    const { data } = await controller.verify(
      { action: 'verify', emailCode: '123456', totpCode: '654321' },
      PRINCIPAL,
    );

    expect(service.verify).toHaveBeenCalledWith(PRINCIPAL, {
      emailCode: '123456',
      totpCode: '654321',
      passkey: undefined,
    });
    expect(data).toEqual({
      outcome: 'delete_account_elevated',
      ticket: 'ticket-1',
      expiresInSeconds: 60,
      action: 'account.delete',
    });
  });

  it('refuses a malformed body before calling the service', async () => {
    const { controller, service } = createController();

    await expect(controller.verify({ action: 'verify' }, PRINCIPAL)).rejects.toBeInstanceOf(
      ProblemException,
    );

    expect(service.verify).not.toHaveBeenCalled();
    expect(service.challenge).not.toHaveBeenCalled();
  });

  it('takes the account from the principal, never from the body', async () => {
    const { controller, service } = createController();

    await controller.verify({ action: 'challenge' }, PRINCIPAL);

    expect(service.challenge).toHaveBeenCalledWith(PRINCIPAL.userId);
  });
});

describe('DeleteAccountController.remove', () => {
  it('deletes and reports the deadline', async () => {
    const { controller, service } = createController();

    const { data } = await controller.remove({}, PRINCIPAL, IP_CLASS);

    expect(service.remove).toHaveBeenCalledWith(PRINCIPAL, false, IP_CLASS);
    expect(data).toEqual({
      outcome: 'account_deleted',
      purgeAt: PURGE_AT.toISOString(),
      reactivationAvailableUntil: PURGE_AT.toISOString(),
    });
  });

  it('passes an explicit acknowledgement through', async () => {
    const { controller, service } = createController();

    await controller.remove({ acknowledgeFundsForfeited: true }, PRINCIPAL, IP_CLASS);

    expect(service.remove).toHaveBeenCalledWith(PRINCIPAL, true, IP_CLASS);
  });

  it('fails closed on a missing acknowledgement', async () => {
    const { controller, service } = createController();

    await controller.remove({}, PRINCIPAL, IP_CLASS);

    // Absent must mean "not acknowledged". This is the one field whose default has to
    // fail toward a refusal.
    expect(service.remove).toHaveBeenCalledWith(PRINCIPAL, false, IP_CLASS);
  });

  it('refuses an unknown field before spending anything', async () => {
    const { controller, service } = createController();

    await expect(
      controller.remove({ purgeNow: true }, PRINCIPAL, IP_CLASS),
    ).rejects.toBeInstanceOf(ProblemException);

    expect(service.remove).not.toHaveBeenCalled();
  });
});

describe('DeleteAccountController.reactivate — the public branch', () => {
  it('requests a code and answers without naming anything', async () => {
    const { controller, service } = createController();

    const { data } = await controller.reactivate(
      { action: 'challenge', email: 'ada@example.test' },
      IP,
      IP_CLASS,
    );

    expect(service.requestReactivation).toHaveBeenCalledWith('ada@example.test', IP);
    expect(data).toEqual({ outcome: 'account_reactivation_requested' });
  });

  it('returns a BYTE-IDENTICAL envelope for every address', async () => {
    // The service returns void on every path, so there is nothing here to branch on.
    // This asserts the property that makes the route safe rather than merely careful.
    const { controller } = createController();

    const a = await controller.reactivate(
      { action: 'challenge', email: 'has-an-account@example.test' },
      IP,
      IP_CLASS,
    );
    const b = await controller.reactivate(
      { action: 'challenge', email: 'never-registered@example.test' },
      IP,
      IP_CLASS,
    );

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('restores and answers', async () => {
    const { controller, service } = createController();

    const { data } = await controller.reactivate(
      { action: 'verify', email: 'ada@example.test', code: '123456' },
      IP,
      IP_CLASS,
    );

    expect(service.reactivate).toHaveBeenCalledWith('ada@example.test', '123456', IP, IP_CLASS);
    expect(data).toEqual({ outcome: 'account_reactivated' });
  });

  it('reads no principal on either branch', async () => {
    // The signature takes none, which is the enforcement: a deleted account has no
    // session, so nothing on this path may depend on one even when a caller happens to
    // present one.
    expect(DeleteAccountController.prototype.reactivate.length).toBe(3);
  });

  it('refuses a malformed body before calling the service', async () => {
    const { controller, service } = createController();

    await expect(
      controller.reactivate({ action: 'verify', email: 'ada@example.test' }, IP, IP_CLASS),
    ).rejects.toBeInstanceOf(ProblemException);

    expect(service.reactivate).not.toHaveBeenCalled();
    expect(service.requestReactivation).not.toHaveBeenCalled();
  });
});
