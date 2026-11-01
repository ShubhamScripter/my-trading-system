import { Module, type OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { COUNTRY_IMAGE_MAX_BYTES } from './country.constants';
import { CountryController } from './country.controller';
import { CountryDbOperation } from './country.dboperation';
import { CountryRoutes } from './country.routes';
import { CountryService } from './country.service';
import { R2CountryImageStorage } from './country.storage';
import { COUNTRY_IMAGE_STORAGE } from './country.types';

/**
 * Registers the bounded multipart parser before the upload route receives a request.
 *
 * ═══ WHY THIS IS HERE AND NOT IN src/main.ts ═══════════════════════════════
 *
 * The global Fastify `bodyLimit` is 64 KiB — deliberately, because every other body
 * this service accepts is a handful of short fields and a megabyte-plus JSON body is
 * not a legitimate request to it. Raising it globally to admit a 1 MiB image would
 * relax that bound on every route in the service, including the unauthenticated ones.
 *
 * `@fastify/multipart` carries its own limits and they apply to multipart requests
 * only, so registering it here buys the upload route its ceiling without touching
 * anyone else's. This is the arrangement src/wallet/core/wallet-core.module.ts uses.
 *
 * ─── The plugin may be registered ONCE per Fastify instance ───────────────
 *
 * A second registration throws. `WalletCoreModule` also registers it, and is NOT
 * mounted in src/app.module.ts — if it is ever mounted, one of the two registrations
 * has to move to a shared module rather than both running.
 */
@Injectable()
class CountryMultipartRegistration implements OnModuleInit {
  constructor(private readonly host: HttpAdapterHost) {}

  async onModuleInit(): Promise<void> {
    const adapter = this.host.httpAdapter;
    // Fail loudly at boot rather than with a confusing 415 on the first upload.
    if (!adapter || adapter.getType() !== 'fastify') {
      throw new Error('CountryModule requires the Fastify adapter.');
    }

    await adapter.getInstance().register(import('@fastify/multipart'), {
      // Enforced while the request is still STREAMING, so an oversized upload is cut
      // off rather than buffered and then measured. `parts: 3` is the two files plus
      // the isoCode field, and `fields: 1` means nothing else can be smuggled alongside.
      limits: { fileSize: COUNTRY_IMAGE_MAX_BYTES, files: 2, fields: 1, parts: 3 },
    });
  }
}

/**
 * The country catalogue and its flag assets.
 *
 * Imports `AuthModule` for `SuperAdminGuard` and `AuthEventDbOperation` — Nest builds a
 * route guard from the injector of the module declaring the controller, so a guard this
 * module's routes wear has to be resolvable from here.
 *
 * `TwoFactorModule` is deliberately NOT imported: no route here uses `ElevationGuard`,
 * and an import for a dependency nothing injects is an edge in the graph that reads as
 * a requirement and is not one. See the elevation note in country.routes.ts.
 *
 * Storage is bound through a token rather than the class, so the concrete adapter is a
 * deployment detail: a test provides a fake, and a future migration off R2 changes this
 * one line. Only the token is exported-by-absence — nothing here is exported at all,
 * because nothing else in the service needs it.
 */
@Module({
  imports: [AuthModule],
  controllers: [CountryRoutes],
  providers: [
    CountryController,
    CountryService,
    CountryDbOperation,
    CountryMultipartRegistration,
    { provide: COUNTRY_IMAGE_STORAGE, useClass: R2CountryImageStorage },
  ],
})
export class CountryModule {}
