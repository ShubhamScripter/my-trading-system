import { Body, type CanActivate, Controller, type ExecutionContext, Get, Injectable,
  HttpCode, Patch, Post, Query, Req, SetMetadata, UseFilters, UseGuards } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from '../../../node_modules/fastify/fastify.js';
import { clientContextOf, headerValue } from '../../../auth/auth.utility.js';
import type { Principal } from '../../../auth/auth.types.js';
import { requirePrincipal } from '../../../auth/security/guards.js';
import { ok, parseDto } from '../../http.js';
import { z } from 'zod';
import { walletAdminChainPageQuerySchema, walletAdminCurrencyPageQuerySchema,
  walletAdminHistoryPageQuerySchema,
  walletCoreHttpPatchSchema, walletProviderCatalogueCoinsPageQuerySchema,
  walletProviderCataloguePageQuerySchema,
  walletProviderCatalogueRefreshInputSchema } from './wallet-core.dto.js';
import { WalletLogoInvalid, WalletLogoTooLarge, WalletPreferenceInvalid,
  WalletAuthorizationUnavailable } from './wallet-core.errors.js';
import { WalletCoreExceptionFilter } from './wallet-core.filter.js';
import { toPublicProviderCataloguePage, toPublicWalletBootstrap,
  toPublicWalletChainPage } from './wallet-core.http-references.js';
import { WALLET_CORE_AUTHORIZATION, WalletCoreService } from './wallet-core.service.js';
import type { WalletAdminAuthorizationPort, WalletAdminPermission,
  WalletAuditContext } from './wallet-core.types.js';
import { WalletAdminBearerGuard } from './wallet-admin-bearer.guard.js';

export const WALLET_CORE_PERMISSION_METADATA = Symbol('WALLET_CORE_PERMISSION_METADATA');
const permission = (value: WalletAdminPermission) => SetMetadata(WALLET_CORE_PERMISSION_METADATA, value);
const LOGO_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/avif',
]);
const timezonePatchSchema = z.object({ timezone: z.string().trim().min(1).max(64)
  .refine((value) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; }
    catch { return false; }
  }, 'Expected an IANA timezone.') }).strict();

function preferencePatch(input: unknown) {
  const parsed = timezonePatchSchema.safeParse(input);
  if (!parsed.success) throw new WalletPreferenceInvalid('Invalid Admin display timezone.');
  return parsed.data;
}

@Injectable()
/** Enforces the per-route Wallet permission recorded by the endpoint decorator. */
export class WalletCorePermissionGuard implements CanActivate {
  constructor(@Inject(WALLET_CORE_AUTHORIZATION)
    private readonly authorization: WalletAdminAuthorizationPort) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const principal = requirePrincipal(context.switchToHttp().getRequest<FastifyRequest>());
    const required = Reflect.getMetadata(WALLET_CORE_PERMISSION_METADATA,
      context.getHandler()) as WalletAdminPermission | undefined;
    if (required === undefined) throw new WalletAuthorizationUnavailable();
    await this.authorization.require(principal, required);
    return true;
  }
}

type MultipartRequest = FastifyRequest & Readonly<{
  file(options: Readonly<{ limits: Readonly<{ fileSize: number; files: number;
    fields: number; parts: number }> }>): Promise<MultipartFile | undefined>;
}>;

function auditContext(request: FastifyRequest, principal: Principal): WalletAuditContext {
  const client = clientContextOf(request.ip, headerValue(request.headers['user-agent']),
    headerValue(request.headers['accept-language']));
  return { actor: { kind: 'ADMIN', actorId: principal.adminId, sessionId: principal.sessionId,
    requestId: request.id, ipAddress: request.ip, deviceId: client.deviceFingerprint } };
}

@Controller('v1/admin/wallet/core')
@UseFilters(WalletCoreExceptionFilter)
@UseGuards(WalletAdminBearerGuard)
/** Admin permissions remain enforced; site-wide save confirmation will be integrated later. */
export class WalletCoreRoutes {
  constructor(@Inject(WalletCoreService) private readonly service: WalletCoreService) {}

  @Get('/')
  @permission('WALLET_CORE_READ')
  @UseGuards(WalletCorePermissionGuard)
  async bootstrap(@Query() query: unknown, @Req() request: FastifyRequest) {
    return ok(toPublicWalletBootstrap(await this.service.bootstrap(requirePrincipal(request),
      parseDto(walletAdminCurrencyPageQuerySchema, query))));
  }

  @Get('chains')
  @permission('WALLET_CORE_READ')
  @UseGuards(WalletCorePermissionGuard)
  async chains(@Query() query: unknown, @Req() request: FastifyRequest) {
    return ok(toPublicWalletChainPage(await this.service.chains(requirePrincipal(request),
      parseDto(walletAdminChainPageQuerySchema, query))));
  }

  @Patch('/')
  @permission('WALLET_CORE_CONFIGURE')
  @UseGuards(WalletCorePermissionGuard)
  async update(@Body() body: unknown, @Req() request: FastifyRequest) {
    const principal = requirePrincipal(request);
    return ok(await this.service.update(principal, parseDto(walletCoreHttpPatchSchema, body),
      auditContext(request, principal)));
  }

  @Get('history')
  @permission('WALLET_CORE_READ')
  @UseGuards(WalletCorePermissionGuard)
  async history(@Query() query: unknown, @Req() request: FastifyRequest) {
    return ok(await this.service.history(requirePrincipal(request),
      parseDto(walletAdminHistoryPageQuerySchema, query)));
  }

  @Get('provider-catalogue')
  @permission('WALLET_CORE_IMPORT')
  @UseGuards(WalletCorePermissionGuard)
  async catalogue(@Query() query: unknown, @Req() request: FastifyRequest) {
    return ok(toPublicProviderCataloguePage(await this.service.catalogue(requirePrincipal(request),
      parseDto(walletProviderCataloguePageQuerySchema, query))));
  }

  @Get('provider-catalogue/coins')
  @permission('WALLET_CORE_IMPORT')
  @UseGuards(WalletCorePermissionGuard)
  async catalogueCoins(@Query() query: unknown, @Req() request: FastifyRequest) {
    return ok(toPublicProviderCataloguePage(await this.service.catalogueCoins(requirePrincipal(request),
      parseDto(walletProviderCatalogueCoinsPageQuerySchema, query))));
  }

  @Post('provider-catalogue/refresh')
  @HttpCode(200)
  @permission('WALLET_CORE_IMPORT')
  @UseGuards(WalletCorePermissionGuard)
  async refreshCatalogue(@Query() query: unknown, @Body() body: unknown,
    @Req() request: FastifyRequest) {
    const principal = requirePrincipal(request);
    parseDto(walletProviderCatalogueRefreshInputSchema, { query, body });
    return ok(await this.service.refreshCatalogue(principal, auditContext(request, principal)));
  }

  @Post('logos')
  @HttpCode(200)
  @permission('WALLET_CORE_CONFIGURE')
  @UseGuards(WalletCorePermissionGuard)
  async uploadLogo(@Req() request: MultipartRequest) {
    const principal = requirePrincipal(request);
    let bytes: Buffer;
    try {
      const file = await request.file({
        limits: { fileSize: 1_048_576, files: 1, fields: 0, parts: 1 },
      });
      if (!file || file.fieldname !== 'file') throw new WalletLogoInvalid('One logo file is required.');
      if (!LOGO_MIME_TYPES.has(file.mimetype)) {
        throw new WalletLogoInvalid('Logo must use PNG, JPEG, WebP, or AVIF content.');
      }
      // Buffer only after Fastify's stream limit has bounded the untrusted upload.
      bytes = await file.toBuffer();
      if (file.file.truncated) throw new WalletLogoTooLarge('Logo must not exceed 1 MiB.');
    } catch (error) {
      if (error instanceof WalletLogoInvalid || error instanceof WalletLogoTooLarge) throw error;
      if (typeof error === 'object' && error !== null
        && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new WalletLogoTooLarge('Logo must not exceed 1 MiB.');
      }
      throw new WalletLogoInvalid('Invalid multipart logo upload.');
    }
    // Storage and audit failures are server errors, not malformed uploads.
    return ok(await this.service.uploadLogo(principal, bytes, auditContext(request, principal)));
  }

  @Patch('preferences')
  @permission('WALLET_CORE_READ')
  @UseGuards(WalletCorePermissionGuard)
  async updatePreferences(@Body() body: unknown, @Req() request: FastifyRequest) {
    const principal = requirePrincipal(request);
    return ok(await this.service.updatePreferences(principal, preferencePatch(body),
      auditContext(request, principal)));
  }
}
