import { Injectable } from '@nestjs/common';
import type { PendingWithdrawalsPort, PendingWithdrawalsState } from './delete-account.types';

/**
 * STUB. Reports that there is no withdrawal subsystem to ask, always.
 *
 * ─── What is and is not stubbed ─────────────────────────────────────────────
 *
 * All of it, and there is less here than in `NullKycProvider` — that stub at least
 * describes a capability someone might later buy. This one stands in for
 * `src/wallet/` and `src/ledger/`, which exist in the tree as seven and six files
 * respectively, every one of them zero bytes. There is no balance column, no ledger
 * table, no withdrawal model and no transaction model anywhere in db/schema.prisma;
 * `schemas = ["identity"]` says so from the other direction, and
 * `VerificationChallenge.ipAddress` notes in passing that "there are no debit paths
 * to restrict".
 *
 * ═══ `unavailable` IS NOT `none`, AND THE DIFFERENCE IS THE WHOLE POINT ══════
 *
 * The obvious signature for this port is `hasWithdrawableFunds(): Promise<boolean>`,
 * and it is wrong. A `false` from an unimplemented subsystem is indistinguishable
 * from a real provider having looked and found an empty balance — so every caller
 * downstream would be reading "this user has no funds" out of a value that means
 * "nobody looked". That is a claim this service has no basis whatsoever to make, and
 * the one place it would surface is a screen telling somebody it is safe to delete an
 * account that may hold money.
 *
 * So the port is three-valued and this implementation returns the third state. It
 * asserts nothing about any user's funds. It reports that the question cannot
 * currently be asked.
 *
 * The same distinction `NullKycProvider` draws between a mismatch and an outage, for
 * the same reason: a stub that collapses "no answer" into the benign answer spends
 * something real on the user's behalf.
 *
 * ─── What the caller does with it ───────────────────────────────────────────
 *
 * `unavailable` does NOT block a deletion. An unbuilt subsystem must not make the
 * feature unusable, and there is demonstrably nothing in this repository to withdraw.
 * It also must not be reported to a client as a zero balance — `DeleteAccountService`
 * passes the state through verbatim and logs it as "withdrawal subsystem not bound".
 *
 * Nothing here withdraws anything, schedules a withdrawal, records a withdrawal
 * address, or marks funds as forfeited. There is no withdrawal endpoint in this
 * feature. The Withdraw Funds API is a future task.
 *
 * ─── Replacing it ───────────────────────────────────────────────────────────
 *
 * Implement `PendingWithdrawalsPort` against the wallet module once it exists, move it
 * beside that module, and rebind `PENDING_WITHDRAWALS_PORT` in settings.module.ts.
 * Keep the contract: `check` never throws, and it returns `none` only when a real
 * provider actually looked. A provider that is bound but erroring should return
 * `unavailable` rather than `none` — the outage must not read as an empty balance
 * either.
 */
@Injectable()
export class NullPendingWithdrawalsProvider implements PendingWithdrawalsPort {
  async check(_userId: string): Promise<PendingWithdrawalsState> {
    return { state: 'unavailable' };
  }
}
