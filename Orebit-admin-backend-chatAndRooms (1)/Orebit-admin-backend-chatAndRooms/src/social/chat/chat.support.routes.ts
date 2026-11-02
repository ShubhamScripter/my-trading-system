/**
 * Admin routes for the support chat (Module 10). All routes need a signed-in admin (the global AuthGuard); an answer
 * and the close button are recorded in the moderation log.
 */
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { requirePrincipal } from '../../../auth/security/guards';
import { ok, type SuccessEnvelope } from '../../http';
import { ChatSupportService } from './services/chat-support.service';

@Controller('social/chat/support')
export class ChatSupportRoutes {
  constructor(private readonly support: ChatSupportService) {}

  /** The ticket queue; `status` is PENDING, OPEN or CLOSED. */
  @Get('tickets')
  async tickets(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.support.tickets(query));
  }

  /** One ticket with a page of its conversation: `?ticketId=&limit=&cursor=`. */
  @Get('ticket')
  async ticket(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.support.ticket(query));
  }

  @Post('tickets/reply')
  async reply(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.support.reply(body, requirePrincipal(req).adminId));
  }

  /** The close button. */
  @Post('tickets/close')
  async close(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.support.close(body, requirePrincipal(req).adminId));
  }
}
