import { Body, Controller, Get, Patch, Query, Req, UseFilters, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../../auth/auth.utility.js';
import { requirePrincipal, SuperAdminGuard } from '../../../auth/security/guards.js';
import { ok, parseDto, type SuccessEnvelope } from '../../http.js';
import { WalletAdminBearerGuard } from '../core/wallet-admin-bearer.guard.js';
import {
  priceConversionBootstrapQuerySchema,
  priceConversionHistoryQuerySchema,
  priceConversionPatchSchema,
  priceConversionPriceQuerySchema,
} from './price-conversion.dto.js';
import { PriceConversionExceptionFilter } from './price-conversion.filter.js';
import { PriceConversionService } from './price-conversion.service.js';
import type {
  PriceConversionBootstrap,
  PriceConversionBootstrapQuery,
  PriceConversionHistoryQuery,
  PriceConversionHistoryPage,
  PriceConversionPricePage,
  PriceConversionPriceQuery,
} from './price-conversion.types.js';

/**
 * Deliberately unmounted: importing PriceConversionModule into AppModule is the
 * explicit deployment step that exposes these four already-authenticated paths.
 */
@Controller('v1/admin/wallet/price-conversion')
@UseGuards(WalletAdminBearerGuard)
export class PriceConversionRoutes {
  constructor(private readonly service: PriceConversionService) {}

  @Get()
  @UseGuards(SuperAdminGuard)
  async bootstrap(@Query() query: unknown): Promise<SuccessEnvelope<PriceConversionBootstrap>> {
    return ok(await this.service.bootstrap(
      parseDto(priceConversionBootstrapQuerySchema, query) as PriceConversionBootstrapQuery,
    ));
  }

  @Patch()
  // Site-wide save confirmation is deferred; current Super Admin checks still apply.
  @UseGuards(SuperAdminGuard)
  @UseFilters(PriceConversionExceptionFilter)
  async update(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<SuccessEnvelope<{ readonly revision: number }>> {
    const principal = requirePrincipal(request);
    const client = clientContextOf(
      request.ip,
      headerValue(request.headers['user-agent']),
      headerValue(request.headers['accept-language']),
    );
    return ok(await this.service.update(parseDto(priceConversionPatchSchema, body), {
      actorId: principal.adminId,
      sessionId: principal.sessionId,
      requestId: request.id,
      ipAddress: request.ip,
      deviceId: client.deviceFingerprint,
    }));
  }

  @Get('history')
  @UseGuards(SuperAdminGuard)
  async history(@Query() query: unknown): Promise<SuccessEnvelope<PriceConversionHistoryPage>> {
    return ok(await this.service.history(
      parseDto(priceConversionHistoryQuerySchema, query) as PriceConversionHistoryQuery,
    ));
  }

  @Get('prices')
  @UseGuards(SuperAdminGuard)
  async prices(@Query() query: unknown): Promise<SuccessEnvelope<PriceConversionPricePage>> {
    return ok(await this.service.prices(
      parseDto(priceConversionPriceQuerySchema, query) as PriceConversionPriceQuery,
    ));
  }
}
