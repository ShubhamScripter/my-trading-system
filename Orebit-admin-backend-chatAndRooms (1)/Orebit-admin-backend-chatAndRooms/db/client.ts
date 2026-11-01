import {
  Global,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { config } from '../src/config';

/**
 * The Prisma client, as a Nest provider so its connection lifecycle is tied to
 * the application's.
 *
 * Only `*.dboperation.ts` files may inject this. That rule is what keeps every
 * service unit-testable against a fake dboperation instead of a fake database —
 * see the module convention in README.md.
 *
 * This client owns the `admin` Postgres schema only. The `identity` schema in the
 * same database belongs to the main Orebit backend and is deliberately absent
 * from db/schema.prisma — two Prisma clients modelling one table is two sources
 * of truth, and the second one to migrate wins.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');

  constructor() {
    super({
      // `databaseUrl`, not `DATABASE_URL`: the resolved form carries the
      // `connection_limit` that `PG_POOL_MAX` names. Without it Prisma sizes the
      // pool from the HOST's CPU count, which in a container is not this
      // process's CPU allowance — see the note on PG_POOL_MAX in src/config.ts.
      datasources: { db: { url: config.databaseUrl } },
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
 * Note it also returns true for a violation raised by a raw-SQL partial index
 * (error code `23505` surfaced through `PrismaClientUnknownRequestError`), which
 * is how `ix_admins_email_active` reports — Prisma does not recognise indexes it
 * did not create.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === UNIQUE_VIOLATION;
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return err.message.includes('23505');
  return false;
}
