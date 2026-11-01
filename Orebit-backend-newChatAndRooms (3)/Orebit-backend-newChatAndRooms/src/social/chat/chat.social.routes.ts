/**
 * The Module 5 routes: commands, mute and block, ads and gifts. Declarative, no logic: every handler hands its parsed
 * input to ChatSocialController. The platform's AuthGuard protects every route.
 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type SuccessEnvelope } from '../../http';
import { body, HandleParam, RoomParam, UuidParam } from './chat.routes';
import {
  AdCancelDto,
  AdDto,
  CommandDto,
  GiftConfirmDto,
  GiftStartDto,
  RelationListQueryDto,
} from './chat.social.dto';
import { ChatSocialController } from './chat.social.controller';

@Controller('social')
export class ChatSocialRoutes {
  constructor(private readonly controller: ChatSocialController) {}

  /** A command typed in chat, e.g. `/mute @bob` (the socket's send_message does the same). */
  @Post('chat/commands')
  command(
    @Req() req: FastifyRequest,
    @Body(body) dto: CommandDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.command(req, dto);
  }

  @Post('chat/users/:userId/mute')
  mute(
    @Req() req: FastifyRequest,
    @Param('userId', new HandleParam()) handle: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.relation(req, handle, 'mutes', true);
  }

  @Post('chat/users/:userId/unmute')
  unmute(
    @Req() req: FastifyRequest,
    @Param('userId', new HandleParam()) handle: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.relation(req, handle, 'mutes', false);
  }

  @Post('chat/users/:userId/block')
  block(
    @Req() req: FastifyRequest,
    @Param('userId', new HandleParam()) handle: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.relation(req, handle, 'blocks', true);
  }

  @Post('chat/users/:userId/unblock')
  unblock(
    @Req() req: FastifyRequest,
    @Param('userId', new HandleParam()) handle: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.relation(req, handle, 'blocks', false);
  }

  @Get('chat/mutes')
  mutes(
    @Req() req: FastifyRequest,
    @Query(body) query: RelationListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.list(req, 'mutes', query);
  }

  @Get('chat/blocks')
  blocks(
    @Req() req: FastifyRequest,
    @Query(body) query: RelationListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.list(req, 'blocks', query);
  }

  @Get('chat/ads/options')
  adOptions(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.adOptions(req);
  }

  @Get('chat/gifts/options')
  giftOptions(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return this.controller.giftOptions(req);
  }

  @Post('chat/ads/quote')
  quoteAd(@Req() req: FastifyRequest, @Body(body) dto: AdDto): Promise<SuccessEnvelope<unknown>> {
    return this.controller.quoteAd(req, dto);
  }

  @Post('chat/ads')
  createAd(@Req() req: FastifyRequest, @Body(body) dto: AdDto): Promise<SuccessEnvelope<unknown>> {
    return this.controller.createAd(req, dto);
  }

  @Get('chat/ads/mine')
  myAds(
    @Req() req: FastifyRequest,
    @Query(body) query: RelationListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.myAds(req, query);
  }

  /** "Separate Advertisement Tab". */
  @Get('chat/ads')
  adFeed(
    @Req() req: FastifyRequest,
    @Query(body) query: RelationListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.adFeed(req, query);
  }

  @Post('chat/ads/:adId/cancel')
  cancelAd(
    @Req() req: FastifyRequest,
    @Param('adId', new UuidParam('adId')) adId: string,
    @Body(body) dto: AdCancelDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.cancelAd(req, adId, dto);
  }

  @Get('chat/rooms/:roomId/pinned-ad')
  pinnedAd(
    @Req() req: FastifyRequest,
    @Param('roomId', new RoomParam()) roomId: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.pinnedAd(req, roomId);
  }

  @Post('chat/gifts')
  startGift(
    @Req() req: FastifyRequest,
    @Body(body) dto: GiftStartDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.startGift(req, dto);
  }

  @Post('chat/gifts/:giftId/confirm')
  confirmGift(
    @Req() req: FastifyRequest,
    @Param('giftId', new UuidParam('giftId')) giftId: string,
    @Body(body) dto: GiftConfirmDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.confirmGift(req, giftId, dto);
  }

  @Post('chat/gifts/:giftId/cancel')
  cancelGift(
    @Req() req: FastifyRequest,
    @Param('giftId', new UuidParam('giftId')) giftId: string,
  ): Promise<SuccessEnvelope<unknown>> {
    return this.controller.cancelGift(req, giftId);
  }
}
