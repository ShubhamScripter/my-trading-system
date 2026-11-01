import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NullPendingWithdrawalsProvider } from '../../../src/settings/delete-account/withdrawals.service';

/**
 * ═══ THE WITHDRAWAL BOUNDARY IS A BOUNDARY, AND NOTHING MORE ════════════════
 *
 * The Withdraw Funds API is out of scope for this feature and will be built as a
 * separate task. What exists here is a port with one question on it and a null
 * implementation that answers "nobody can be asked".
 *
 * The assertions below are mostly about what does NOT exist, because that is the thing
 * that could quietly stop being true: a later edit that adds a balance field, a
 * withdrawal address, or a method that moves money would mean the withdrawal system had
 * started growing inside the deletion feature.
 *
 * The most important one is that `unavailable` is not `none`. A boolean port would have
 * made those indistinguishable, and the consequence would land on a screen telling
 * somebody it is safe to delete an account that might hold money.
 */

const ROOT = join(process.cwd(), 'src', 'settings', 'delete-account');

describe('NullPendingWithdrawalsProvider', () => {
  it('reports that no subsystem is bound', async () => {
    const provider = new NullPendingWithdrawalsProvider();

    expect(await provider.check('user-1')).toEqual({ state: 'unavailable' });
  });

  it('never reports `none`, which would be a claim about the user`s funds', async () => {
    const provider = new NullPendingWithdrawalsProvider();

    // `none` means a real provider looked and found nothing. This one did not look.
    for (const userId of ['user-1', 'user-2', '']) {
      expect((await provider.check(userId)).state).not.toBe('none');
    }
  });

  it('never throws — the port`s contract', async () => {
    const provider = new NullPendingWithdrawalsProvider();

    // `KycStatusPort.isVerified` sets the same contract: a status read that can throw
    // would make every caller handle an outage it cannot do anything about.
    await expect(provider.check('user-1')).resolves.toBeDefined();
  });

  it('is a no-op — it has one method, and that method is a question', () => {
    const methods = Object.getOwnPropertyNames(NullPendingWithdrawalsProvider.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(methods).toEqual(['check']);
  });
});

describe('no withdrawal functionality exists in this feature', () => {
  const sources = [
    'delete-account.service.ts',
    'delete-account.controller.ts',
    'delete-account.routes.ts',
    'delete-account.dto.ts',
    'delete-account.utility.ts',
    'delete-account.sweeper.ts',
    'withdrawals.service.ts',
  ].map((name) => [name, readFileSync(join(ROOT, name), 'utf8')] as const);

  it('declares no route that could accept a withdrawal or an address', () => {
    const routes = readFileSync(join(ROOT, 'delete-account.routes.ts'), 'utf8');
    const declared = [...routes.matchAll(/@(?:Get|Post|Put|Patch|Delete)\('([^']*)'\)/g)].map(
      (match) => match[1],
    );

    expect(declared).toEqual([
      'security/delete-account',
      'security/delete-account/verify',
      'security/delete-account',
      'security/delete-account/reactivate',
    ]);
    for (const path of declared) {
      expect(path).not.toMatch(/withdraw|wallet|ledger|balance|payout|address/i);
    }
  });

  it('imports nothing from the wallet or ledger placeholders', () => {
    for (const [name, source] of sources) {
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const specifier of imports) {
        expect(`${name}: ${specifier}`).not.toMatch(/wallet|ledger/i);
      }
    }
  });

  it('contains no code that could move funds', () => {
    // Deliberately a source-level assertion rather than a behavioural one. The property
    // being protected is "this feature did not grow half a withdrawal system", and that
    // is a statement about what is written, not about what one call returns.
    const forbidden =
      /\b(withdrawTo|sendFunds|transferFunds|createWithdrawal|debitBalance|creditBalance|payout)\b/i;

    for (const [name, source] of sources) {
      expect(forbidden.test(source), `${name} contains a funds-moving call`).toBe(false);
    }
  });

  it('never converts `unavailable` into a claim about funds', () => {
    const service = readFileSync(join(ROOT, 'delete-account.service.ts'), 'utf8');

    // The specific mistake this boundary is shaped to prevent. A comparison like
    // `state === 'unavailable' ? 'none' : ...` or a boolean coercion of the state would
    // be the shape of it.
    expect(service).not.toMatch(/unavailable['"]\s*\?\s*['"]none/);
    expect(service).not.toMatch(/state\s*!==?\s*['"]unavailable['"]\s*\?\s*(?:true|false)/);
  });

  it('says plainly in its own source that withdrawals are out of scope', () => {
    const provider = readFileSync(join(ROOT, 'withdrawals.service.ts'), 'utf8');

    // The file is the thing a future reader reaches for when they come to build the real
    // subsystem, so the contract it has to keep is written on it.
    expect(provider).toMatch(/future task/i);
    expect(provider).toMatch(/asserts nothing about any user's funds/i);
  });
});
