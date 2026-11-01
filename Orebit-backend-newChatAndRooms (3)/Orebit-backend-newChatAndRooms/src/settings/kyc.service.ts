import { Injectable } from '@nestjs/common';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import type { KycEvidence, KycStatusPort } from './settings.types';

/**
 * STUB. Reports every account unverified, always.
 *
 * ─── What is and is not stubbed ─────────────────────────────────────────────
 *
 * All of it. Unlike `NullGeoResolver`, which still records the IP it cannot resolve,
 * there is nothing here to record: this service has no table, no column on `User`,
 * no upload surface and no provider. Nothing in the repository has ever held KYC
 * state, so there is also no history to preserve and no backfill to plan for.
 *
 * The consequence is precise and intended: `isVerified` returns false, so
 * `GET /settings/security/passkeys` reports the `kyc+otp` path unavailable and
 * `disable` refuses it before charging its quota or consuming an emailed code. The
 * path exists in the policy table, is covered by tests, and grants nothing.
 *
 * `reverify` throws rather than returning false, and the distinction matters even in
 * a stub: `false` is a *mismatch*, meaning the provider looked and the face did not
 * match, which is a real answer that costs the user an attempt. This is not that. It
 * is "there is no provider", and the port's contract says an unavailable provider
 * refunds. Returning false here would make the stub silently spend a user's monthly
 * allowance. In practice `isVerified` gates it first, so this is unreachable
 * defence — which is exactly the kind that should be correct anyway.
 *
 * ─── Replacing it ───────────────────────────────────────────────────────────
 *
 * Implement `KycStatusPort` against whichever provider is chosen, move it into its
 * own module beside `src/geo/`, and rebind `KYC_PORT` in settings.module.ts. Keep
 * the port's two contracts: `isVerified` never throws, and `reverify` distinguishes
 * a mismatch (`false`) from an outage (throw).
 */
@Injectable()
export class NullKycProvider implements KycStatusPort {
  async isVerified(_userId: string): Promise<boolean> {
    return false;
  }

  async reverify(_userId: string, _evidence: KycEvidence): Promise<boolean> {
    throw new ProblemException({
      type: ERR.MFA_METHOD_UNAVAILABLE,
      detail: 'Identity reverification is not available on this account.',
    });
  }
}
