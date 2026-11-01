import { Module } from '@nestjs/common';
import { AuthModule } from '../../../auth/auth.module.js';
import { AdminAuditWriterModule } from '../../admin-audits/admin-audit.writer.module.js';
import { PriceConversionExceptionFilter } from './price-conversion.filter.js';
import { PRICE_CONVERSION_DATABASE, PriceConversionDatabase, PriceConversionDbOperation } from './price-conversion.dboperation.js';
import { PriceConversionRoutes } from './price-conversion.routes.js';
import { PRICE_CONVERSION_STORE, PriceConversionService } from './price-conversion.service.js';
import { WalletAdminBearerGuard } from '../core/wallet-admin-bearer.guard.js';

/** Not imported by AppModule: strict isolation keeps all four routes unmounted. */
@Module({
  imports: [AuthModule, AdminAuditWriterModule],
  controllers: [PriceConversionRoutes],
  providers: [
    PriceConversionDatabase,
    { provide: PRICE_CONVERSION_DATABASE, useExisting: PriceConversionDatabase },
    PriceConversionDbOperation,
    { provide: PRICE_CONVERSION_STORE, useExisting: PriceConversionDbOperation },
    PriceConversionService,
    WalletAdminBearerGuard,
    PriceConversionExceptionFilter,
  ],
})
export class PriceConversionModule {}
