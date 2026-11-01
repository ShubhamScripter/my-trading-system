import { Inject, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from '../../../node_modules/fastify/fastify.js';

export const WALLET_CORE_CONFIG_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

const CONFIGURATION_PATHS = new Set([
  '/v1/admin/wallet/core',
  '/v1/admin/wallet/core/',
]);

/** Installs the one approved JSON-body exception before Fastify registers Nest routes. */
export function registerWalletCoreRequestLimit(instance: FastifyInstance): void {
  instance.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.includes('PATCH') && CONFIGURATION_PATHS.has(route.url)) {
      route.bodyLimit = WALLET_CORE_CONFIG_BODY_LIMIT_BYTES;
    }
  });
}

/** Registers the Fastify hook during Nest module setup, before controller routes are mapped. */
@Module({})
export class WalletCoreRequestLimitModule implements NestModule {
  constructor(@Inject(HttpAdapterHost) private readonly host: HttpAdapterHost) {}

  configure(_consumer: MiddlewareConsumer): void {
    const adapter = this.host.httpAdapter;
    if (!adapter || adapter.getType() !== 'fastify') throw new Error('WALLET_FASTIFY_REQUIRED');
    registerWalletCoreRequestLimit(adapter.getInstance());
  }
}
