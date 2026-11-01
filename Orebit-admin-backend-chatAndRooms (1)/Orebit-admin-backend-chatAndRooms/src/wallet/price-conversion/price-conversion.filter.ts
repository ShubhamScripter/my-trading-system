import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PriceConfigurationConflict, PriceConfigurationValidationError } from './price-conversion.errors.js';

/** Maps expected price-domain failures to module-scoped RFC 9457 responses. */
@Catch(PriceConfigurationConflict, PriceConfigurationValidationError)
export class PriceConversionExceptionFilter implements ExceptionFilter {
  catch(error: PriceConfigurationConflict | PriceConfigurationValidationError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const conflict = error instanceof PriceConfigurationConflict;
    void response.status(error.status).header('content-type', 'application/problem+json').send({
      type: error.code,
      title: conflict ? 'Price configuration revision conflict' : 'Invalid price configuration',
      status: error.status,
      ...(!conflict ? { detail: error.message } : {}),
      instance: request.url,
      requestId: request.id,
      ...(conflict ? { extra: { actualRevision: error.actualRevision } } : {}),
    });
  }
}
