import { Global, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { config } from '../src/config';

/**
 * The Prisma client, as a Nest provider so its connection lifecycle is tied to
 * the application's.
 *
 * Only `*.dboperation.ts` files may inject this. That rule is what keeps every
 * service unit-testable against a fake dboperation instead of a fake database —
 * see the module convention in README.md.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');

  constructor() {
    super({
      datasources: { db: { url: config.DATABASE_URL } },
      log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/**
 * Global because the client is a connection pool and must be a singleton. It is
 * exported to every module, but only `*.dboperation.ts` files are permitted to
 * inject it — that restriction is review discipline, not something the framework
 * can enforce.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DbModule {}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * True when `err` is a unique-constraint violation.
 *
 * Username allocation depends on this: it inserts and catches, rather than
 * checking availability first, because a check-then-insert loses the race
 * against a concurrent signup that picks the same name. The database's partial
 * unique index is the only authority that cannot be raced.
 *
 * Note it also returns true for a violation raised by a raw-SQL partial index
 * (error code `23505` surfaced through `PrismaClientUnknownRequestError`), which
 * is how `ix_users_username_active` reports — Prisma does not recognise indexes
 * it did not create.
 */
/**
 * Whether a unique violation came from one named index.
 *
 * Matches the index name in the error *message*, not `meta.target`, and that is
 * forced rather than lazy: every uniqueness rule on `users` and `oauth_links` is a
 * partial index in db/sql/identity.sql. Prisma did not create those, cannot see
 * them, and reports the violation as `PrismaClientUnknownRequestError` with no
 * `meta` at all — the index name survives only in the raw Postgres text.
 *
 * Call it behind `isUniqueViolation`, never instead of it.
 */
export function violatedIndex(err: unknown, indexName: string): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes(indexName);
}

export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === UNIQUE_VIOLATION;
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return err.message.includes('23505');
  return false;
}
