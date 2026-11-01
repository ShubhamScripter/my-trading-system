import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/client';

/**
 * Which captcha providers an operator has switched off.
 *
 * ═══ THIS READS A TABLE THIS SERVICE DOES NOT OWN ═══════════════════════════
 *
 * `admin.admin_captcha_providers` belongs to Orebit-admin-backend. This service
 * only ever SELECTs from it, and deliberately does not model it in db/schema.prisma
 * — that datasource is `schemas = ["identity"]` on purpose, because two Prisma
 * clients modelling one table is two sources of truth and whichever migrates second
 * wins. So the query is raw, following the same precedent as the `identity.sessions`
 * statement in auth/persistence/session.dboperation.ts.
 *
 * The consequence to know about: a column renamed in the admin repo breaks this
 * reader, and nothing in either repo's type system will say so. The model's doc
 * comment over there carries the matching warning.
 *
 * Both services point at the same database (one Postgres, two schemas). If the two
 * ever get separate roles, this one needs `GRANT USAGE ON SCHEMA admin` and
 * `GRANT SELECT ON admin.admin_captcha_providers`, and nothing more. A missing
 * grant is safe rather than fatal: the query throws, and the caller keeps the
 * provider set it already had.
 */
@Injectable()
export class CaptchaProviderDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * THROWS — the caller owns the fallback.
   *
   * "Nothing is disabled" and "we could not ask" may only be turned into the same
   * answer by the layer that knows the env set. See `CaptchaSettingsService.refresh`.
   *
   * Returns `string[]` and NOT `CaptchaProvider[]`: the column is free text by
   * design, and an operator's typo must not become a type lie.
   *
   * Schema-qualified, so it does not depend on `search_path` — this service's
   * connection string does not name the `admin` schema and never should.
   */
  async disabled(): Promise<readonly string[]> {
    const rows = await this.prisma.$queryRaw<{ provider: string }[]>`
      SELECT provider
        FROM admin.admin_captcha_providers
       WHERE enabled = false
    `;

    return rows.map((row) => row.provider);
  }
}
