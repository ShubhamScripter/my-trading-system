/**
 * The support chat routes (Module 10). Declarative, no logic: every handler hands its parsed input to
 * SupportController. The platform's AuthGuard protects every route.
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type SuccessEnvelope } from '../../../http';
import { body, UuidParam } from '../chat.routes';
import { SupportController } from './support.controller';
import * as dto from './support.dto';

const id = (): UuidParam => new UuidParam('ticketId');

@Controller('social')
export class SupportRoutes {
  constructor(private readonly controller: SupportController) {}

  /** Opens a ticket (PENDING) with its first message. */
  @Post('chat/support/tickets')
  open(
    @Req() req: FastifyRequest,
    @Body(body) b: dto.SupportCreateDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.open(req, b);
  }

  /** The user's tickets, optionally one status (PENDING, OPEN or CLOSED). */
  @Get('chat/support/tickets')
  list(
    @Req() req: FastifyRequest,
    @Query(body) query: dto.SupportListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.list(req, query);
  }

  @Get('chat/support/tickets/:ticketId')
  get(
    @Req() req: FastifyRequest,
    @Param('ticketId', id()) ticketId: string,
    @Query(body) query: dto.SupportMessagesQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.get(req, ticketId, query);
  }

  @Post('chat/support/tickets/:ticketId/messages')
  post(
    @Req() req: FastifyRequest,
    @Param('ticketId', id()) ticketId: string,
    @Body(body) b: dto.SupportMessageDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.post(req, ticketId, b);
  }

  /** The close button. */
  @Post('chat/support/tickets/:ticketId/close')
  close(
    @Req() req: FastifyRequest,
    @Param('ticketId', id()) ticketId: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.close(req, ticketId);
  }
}
