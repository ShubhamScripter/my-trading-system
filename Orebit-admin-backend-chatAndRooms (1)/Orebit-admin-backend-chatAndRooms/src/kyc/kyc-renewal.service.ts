import { Injectable, Logger } from '@nestjs/common';
import { AUTH_EVENT, AuthEventDbOperation } from '../../auth/auth.dboperation';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import {
  KycRenewalDbOperation,
  type KycRenewalImpact,
  type KycRenewalSettingsRow,
} from './kyc-renewal.dboperation';
import type { KycRenewalPayload, KycRenewalRequest } from './kyc-renewal.dto';

/**
 * ═══ CONFIGURING WHEN KYC EXPIRES ══════════════════════════════════════════
 *
 * Two global numbers, and this is the only surface anywhere that can write them. Until
 * a super admin does, both are NULL and the consumer never expires anything — the
 * renewal engine over there is complete and inert, and this service is the switch.
 *
 * ─── What it cannot reach ─────────────────────────────────────────────────
 *
 * Nothing but those two numbers. It cannot write `kyc_level_states`, cannot write
 * `kyc_verifications`, cannot mark an account verified or expired, and cannot exempt
 * anyone. What an account has proved is the provider's word arriving over a signed
 * webhook in ../Orebit-backend; configuration decides when that word goes stale, never
 * whether it was said. `KycExemptionService` is the surface for relieving one account,
 * and it is deliberately a different one.
 *
 * ─── The audit event is not renewal history ───────────────────────────────
 *
 * Every write records `KYC_RENEWAL_SETTINGS_UPDATED` against the platform's existing
 * admin audit infrastructure, the same as every other admin write in this service. That
 * is independent of the renewal configuration itself: there is no renewal-history table,
 * no stored `reason`, and no previous-value column anywhere. The audit log holds who,
 * when and what the periods became; the settings row holds only what applies now.
 */
const SECONDS_PER_DAY = 24 * 60 * 60;

@Injectable()
export class KycRenewalService {
  private readonly logger = new Logger('KycRenewal');

  constructor(
    private readonly settings: KycRenewalDbOperation,
    private readonly events: AuthEventDbOperation,
  ) {}

  /** The live configuration. A pure read — it writes nothing and audits nothing. */
  async state(): Promise<KycRenewalPayload> {
    return toPayload(await this.require());
  }

  /**
   * Set X and Y.
   *
   * ─── The impact is measured BEFORE the write ──────────────────────────────
   *
   * Not for the response — the response is the two periods and nothing else — but for
   * the audit event and the warning log. Measured first so the number recorded is the
   * population the operator actually affected, rather than one taken afterwards, when
   * it would already be describing the new state.
   */
  async update(
    input: KycRenewalRequest,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycRenewalPayload> {
    const mandatoryPeriodSeconds = toSeconds(input.mandatoryPeriodDays);
    const voluntaryPeriodSeconds = toSeconds(input.voluntaryPeriodDays);

    const impact = await this.settings.impactOf(mandatoryPeriodSeconds);

    const written = await this.settings.write({
      mandatoryPeriodSeconds,
      voluntaryPeriodSeconds,
    });
    if (!written) this.reportMissingRow();

    // WARN rather than log: this changes whether every account on the platform is
    // considered verified, and `levelsAffected` is how many stopped being so at this
    // instant. It belongs in whatever an operator greps when something goes wrong.
    this.logger.warn(
      {
        actorAdminId: actor.adminId,
        mandatoryPeriodSeconds,
        voluntaryPeriodSeconds,
        levelsAffected: impact.levelsAffected,
        usersAffected: impact.usersAffected,
      },
      'kyc renewal periods updated',
    );

    await this.events.record({
      eventType: AUTH_EVENT.KYC_RENEWAL_SETTINGS_UPDATED,
      adminId: actor.adminId,
      client,
      metadata: {
        mandatoryPeriodSeconds,
        voluntaryPeriodSeconds,
        // The blast radius, recorded at the moment it was caused. With no versions
        // table behind this feature any more, this row is the whole record of the
        // change — which is why the periods themselves are on it and not just a count.
        levelsAffected: impact.levelsAffected,
        usersAffected: impact.usersAffected,
      },
    });

    // Re-read rather than echo the request. What comes back is what the table holds,
    // so a CHECK that quietly refused something could not be reported as applied.
    return toPayload(await this.require());
  }

  /**
   * The singleton row, or a refusal.
   *
   * Its absence is a broken deployment, not a client error: the consumer's migration
   * seeds it. Reporting it as a 404 rather than inventing an all-null default is
   * deliberate — a fabricated "renewal is off" would be indistinguishable from the real
   * thing, and an operator would believe they had read the configuration when the table
   * they need is not there.
   */
  private async require(): Promise<KycRenewalSettingsRow> {
    const row = await this.settings.read();
    if (row !== null) return row;
    this.reportMissingRow();
  }

  private reportMissingRow(): never {
    this.logger.error(
      {},
      'identity.kyc_renewal_settings has no singleton row; the consumer migration has ' +
        'not been applied to this database',
    );
    throw new ProblemException({ type: ERR.NOT_FOUND });
  }
}

/** Seconds are what the column holds; days are what an operator writes. */
function toSeconds(days: number | null): number | null {
  return days === null ? null : days * SECONDS_PER_DAY;
}

/**
 * Days, from the stored seconds, EXACTLY.
 *
 * This API can only ever write whole days, but a value put straight into the table by
 * hand during an incident need not divide evenly. When it does not, the quotient comes
 * back fractional rather than rounded: a rounded day count would be a number the
 * operator could read, re-submit unchanged, and silently alter the configuration by
 * doing so. A fraction is the truth, and `z.number().int()` refuses it on the way back
 * in, so the mistake is impossible in both directions.
 */
function toDays(seconds: number | null): number | null {
  return seconds === null ? null : seconds / SECONDS_PER_DAY;
}

function toPayload(row: KycRenewalSettingsRow): KycRenewalPayload {
  return {
    mandatoryPeriodDays: toDays(row.mandatory_period_seconds),
    voluntaryPeriodDays: toDays(row.voluntary_period_seconds),
  };
}

export type { KycRenewalImpact };
