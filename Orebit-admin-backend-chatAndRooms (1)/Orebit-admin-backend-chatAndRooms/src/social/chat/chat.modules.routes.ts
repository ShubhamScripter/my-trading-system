/**
 * Admin routes for chat Modules 4–9: restrictions, ban edits, the bot log and staff requests (Module 4), ads, gifts,
 * their reverts and the command log (Module 5), and oversight of direct messages and groups (Modules 8–9). All routes need a signed-in admin (the
 * global AuthGuard); every change is recorded in the moderation log. Chat-wide settings for these modules (staff
 * permissions, commands, gifts, ads, DM, groups, privacy) are saved through the existing `settings` route.
 */
import { Body, Controller, Get, Injectable, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { requirePrincipal } from '../../../auth/security/guards';
import { ok, type SuccessEnvelope } from '../../http';
import { ChatModulesService } from './services/chat-modules.service';
import { ChatMoneyService } from './services/chat-money.service';
import { ChatStaffRequestsService } from './services/chat-staff-requests.service';

/** Wraps each Module 4–9 service call in the standard success envelope. */
@Injectable()
export class ChatModulesController {
  constructor(private readonly service: ChatModulesService) {}

  async run<T>(work: Promise<T>): Promise<SuccessEnvelope<T>> {
    return ok(await work);
  }
}

@Controller('social/chat')
export class ChatModulesRoutes {
  constructor(
    private readonly controller: ChatModulesController,
    private readonly service: ChatModulesService,
    private readonly money: ChatMoneyService,
    private readonly requests: ChatStaffRequestsService,
  ) {}

  private admin(req: FastifyRequest): string {
    return requirePrincipal(req).adminId;
  }

  // Module 4
  @Get('restrictions')
  restrictions(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.service.restrictions(query));
  }

  @Post('restrictions')
  createRestriction(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.service.createRestriction(body, this.admin(req)));
  }

  @Post('restrictions/lift')
  liftRestriction(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.service.liftRestriction(body, this.admin(req)));
  }

  @Post('restrictions/change')
  changeRestriction(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.service.changeRestriction(body, this.admin(req)));
  }

  @Post('bans/change')
  changeBan(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.service.changeBan(body, this.admin(req)));
  }

  @Get('bot-log')
  botLog(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.service.botLog(query));
  }

  @Get('staff/requests')
  staffRequests(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.requests.staffRequests(query));
  }

  @Post('staff/requests/resolve')
  resolveStaffRequest(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<unknown>> {
    const { adminId, role } = requirePrincipal(req);
    return this.controller.run(this.requests.resolveStaffRequest(body, adminId, role));
  }

  // Module 5
  @Get('ads')
  ads(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.money.ads(query));
  }

  @Post('ads')
  createAd(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.money.createAd(body, this.admin(req)));
  }

  @Post('ads/cancel')
  cancelAd(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.money.cancelAd(body, this.admin(req)));
  }

  /** "Revert ALL Advertisements for a Specific Time Frame"; `dryRun: true` lists what it would revert. */
  @Post('ads/revert')
  revertAds(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.money.revertAds(body, this.admin(req)));
  }

  @Get('gifts')
  gifts(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.money.gifts(query));
  }

  /** "Revert ALL Transfers for a Specific Time Frame"; `dryRun: true` only counts. */
  @Post('gifts/revert')
  revertGifts(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.money.revertGifts(body, this.admin(req)));
  }

  @Get('commands')
  commandLog(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.money.commandLog(query));
  }

  // Modules 8–9
  @Get('dm/conversations')
  userConversations(
    @Query() query: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.service.userConversations(query, this.admin(req)));
  }

  /** POST, because reading a private conversation needs a recorded reason in the body. */
  @Post('dm/conversations/read')
  readConversation(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.service.readConversation(body, this.admin(req)));
  }

  @Get('dm/groups')
  groups(@Query() query: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.run(this.service.groups(query, this.admin(req)));
  }
}
