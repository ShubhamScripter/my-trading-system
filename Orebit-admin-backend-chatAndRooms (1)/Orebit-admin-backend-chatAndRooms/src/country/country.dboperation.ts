import { Injectable } from '@nestjs/common';
import type { Country } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../utils/public.utils';

/**
 * `admin.countries`, which THIS service owns.
 *
 * Prisma model access rather than raw SQL, unlike `KycPolicyDbOperation` and
 * `SecurityPolicyDbOperation` beside it — those reach into `identity`, a schema this
 * service does not own and deliberately does not model. This table is in `admin`, is
 * declared in db/schema.prisma, and so gets the type checking the others cannot have.
 *
 * The consumer backend reads it from the other side with a read-only raw query, the way
 * it already reads `admin.admin_captcha_providers`. Renaming a column here is a breaking
 * change for that reader and nothing in either repository's type system will say so —
 * the model's doc comment carries the matching warning.
 */
@Injectable()
export class CountryDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every country, or the one with this code.
   *
   * Ordered by ISO code rather than by name: the code is the stable identifier, so the
   * ordering stays put when a country is renamed. Sorting by name would also be wrong in
   * any locale other than the one Postgres happens to be collating in.
   *
   * No pagination. There are at most 249 rows, the whole set is what a country picker
   * renders, and a cursor would be machinery guarding a bound that cannot be exceeded.
   */
  async list(isoCode?: string): Promise<readonly Country[]> {
    return this.prisma.country.findMany({
      ...(isoCode === undefined ? {} : { where: { isoCode } }),
      orderBy: { isoCode: 'asc' },
    });
  }

  /**
   * Inserts a country, images and all.
   *
   * ═══ A COUNTRY IS CREATED COMPLETE ═════════════════════════════════════════
   *
   * Both image keys are written in the same INSERT as the name and the code, because by
   * the time this is called the admin has already chosen or uploaded both — that is what
   * the image library is for. There is no `attachImages` step any more and no window in
   * which a row exists with half a flag pair: the previous flow needed one only because
   * uploads required the row to exist first.
   *
   * THROWS on a duplicate ISO code rather than checking first — `UNIQUE(iso_code)` is
   * the authority, and `isUniqueViolation` is how the service recognises it. A
   * read-then-insert would be a race two admins can lose together, which is the
   * reasoning behind every compare-and-swap in this codebase.
   *
   * The keys are validated by the service before they get here: proven to be ours, in
   * the right slots, and present in the bucket. This layer stores what it is given.
   *
   * `uuidv7()` and never `gen_random_uuid()`: time-ordered, so inserts stay at the right
   * edge of the B-tree. The schema header states this for every model.
   */
  async create(input: {
    readonly name: string;
    readonly isoCode: string;
    readonly roundImageKey: string;
    readonly squareImageKey: string;
    readonly imagesUpdatedAt: Date;
  }): Promise<Country> {
    return this.prisma.country.create({
      data: {
        id: uuidv7(),
        name: input.name,
        isoCode: input.isoCode,
        roundImageKey: input.roundImageKey,
        squareImageKey: input.squareImageKey,
        imagesUpdatedAt: input.imagesUpdatedAt,
      },
    });
  }

  /** One country by code, or null. */
  async findByIsoCode(isoCode: string): Promise<Country | null> {
    return this.prisma.country.findUnique({ where: { isoCode } });
  }
}
