import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from '../../../node_modules/fastify/fastify.js';
import {
  WalletConfigurationConflict,
  WalletDomainError,
  WalletValidationError,
} from './wallet-core.errors.js';

/** Maps only expected Wallet failures to module-scoped RFC 9457 responses. */
@Catch(WalletDomainError)
export class WalletCoreExceptionFilter implements ExceptionFilter {
  catch(error: WalletDomainError, host: ArgumentsHost): void {
    if (!(error instanceof WalletDomainError)) throw error;

    const http = host.switchToHttp();
    const response = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const validation = error instanceof WalletValidationError;
    const conflict = error instanceof WalletConfigurationConflict;

    void response.status(error.status).header('content-type', 'application/problem+json').send({
      type: error.code,
      title: error.title,
      status: error.status,
      ...(validation && error.detail !== undefined ? { detail: error.detail } : {}),
      instance: request.url,
      requestId: request.id,
      ...(conflict ? { extra: { actualRevision: error.actualRevision } } : {}),
    });
  }
}
