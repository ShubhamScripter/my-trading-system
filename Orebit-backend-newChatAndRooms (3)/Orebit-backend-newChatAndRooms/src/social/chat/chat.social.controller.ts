/**
 * Module 5 over HTTP: commands typed in chat, mute and block, ads, and gifts. Paths are in chat.social.routes.ts.
 * The socket's `send_message` runs the same commands (`/mute @bob`), through the same ChatCommandsService.
 */
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { requirePrincipal } from '../../../auth/security/guards';
import { config } from '../../config';
import { cloudflareAnonymised } from './chat.edge';
import { ok, type SuccessEnvelope } from '../../http';
import { requestFactsOf } from '../../restrictions/restrictions.service';
import { ChatAccessService } from './chat.access.service';
import { ChatAuthHelper } from './chat.auth.helper';
import type {
  AdCancelDto,
  AdDto,
  CommandDto,
  GiftConfirmDto,
  GiftStartDto,
  RelationListQueryDto,
} from './chat.social.dto';
import type { ChatUserContext } from './chat.types';
import { clientIp } from './chat.utility';
import { ChatAdsService } from './services/chat.ads.service';
import { ChatAdsReadService } from './services/chat.ads.read';
import { ChatCommandsService } from './services/chat.commands.service';
import { ChatActionGate } from './services/chat.action-gate.service';
import { ChatGiftsService } from './services/chat.gifts.service';
import { ChatRelationsService } from './services/chat.relations.service';

@Injectable()
export class ChatSocialController {
  constructor(
    private readonly auth: ChatAuthHelper,
    private readonly access: ChatAccessService,
    private readonly commands: ChatCommandsService,
    private readonly relations: ChatRelationsService,
    private readonly ads: ChatAdsService,
    private readonly adsRead: ChatAdsReadService,
    private readonly gifts: ChatGiftsService,
    private readonly gate: ChatActionGate,
  ) {}

  private user(req: FastifyRequest): Promise<ChatUserContext> {
    return this.auth.getChatUser(req);
  }

  private ip(req: FastifyRequest): string {
    return clientIp(req.headers['x-forwarded-for'], req.ip, config.trustedProxies);
  }

  async command(req: FastifyRequest, dto: CommandDto): Promise<SuccessEnvelope<unknown>> {
    const facts = requestFactsOf(req);
    return ok(
      await this.commands.run(await this.user(req), {
        roomRef: dto.roomId,
        text: dto.text,
        ip: this.ip(req),
        // For /rain's security tiers: which session, network and country this request is on.
        context: {
          sessionId: requirePrincipal(req).sessionId,
          ipClass: facts.ipClass,
          country: facts.country,
          anonymised: cloudflareAnonymised(req.headers),
        },
      }),
    );
  }

  async relation(
    req: FastifyRequest,
    handle: string,
    list: 'mutes' | 'blocks',
    on: boolean,
  ): Promise<SuccessEnvelope<unknown>> {
    const user = await this.user(req);
    const command = list === 'mutes' ? (on ? 'mute' : 'unmute') : on ? 'block' : 'unblock';
    await this.gate.assert(user, command, { ip: this.ip(req) });
    return ok(await this.relations.set(user, handle, list, on));
  }

  async list(
    req: FastifyRequest,
    list: 'mutes' | 'blocks',
    query: RelationListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    const user = await this.user(req);
    await this.gate.assert(user, list === 'mutes' ? 'mutelist' : 'blocklist', { ip: this.ip(req), limit: false });
    return ok(await this.relations.list(user, list, query));
  }

  async quoteAd(req: FastifyRequest, dto: AdDto): Promise<SuccessEnvelope<unknown>> {
    await this.gate.assert(await this.user(req), 'ad', { ip: this.ip(req), limitKey: 'ad_quote' });
    return ok(await this.ads.quote(dto));
  }

  async createAd(req: FastifyRequest, dto: AdDto): Promise<SuccessEnvelope<unknown>> {
    const user = await this.user(req);
    await this.gate.assert(user, 'ad', { ip: this.ip(req) });
    return ok(await this.ads.create(user, dto, this.ip(req), dto.idempotencyKey));
  }

  async myAds(req: FastifyRequest, query: RelationListQueryDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.adsRead.mine(await this.user(req), query));
  }

  async adFeed(
    req: FastifyRequest,
    query: RelationListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.adsRead.feed(await this.user(req), query));
  }

  async cancelAd(req: FastifyRequest, adId: string, dto: AdCancelDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.ads.cancel(await this.user(req), adId, dto.refundCurrency));
  }

  async adOptions(_req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.adsRead.options());
  }

  async giftOptions(req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    let user: ChatUserContext | undefined;
    try {
      user = await this.user(req);
    } catch {
      // unauthenticated
    }
    return ok(await this.gifts.options(user));
  }

  /** The pinned ad showing in a room (for a client that joined over HTTP or missed the event). */
  async pinnedAd(req: FastifyRequest, roomRef: string): Promise<SuccessEnvelope<unknown>> {
    const user = await this.user(req);
    const { room } = await this.access.assertCanView(user, roomRef);
    const country = (await this.access.factsFor(user)).country;
    return ok({ roomId: room.id, pinnedAd: await this.ads.activePin(room.id, country, user.id) });
  }

  async startGift(req: FastifyRequest, dto: GiftStartDto): Promise<SuccessEnvelope<unknown>> {
    const user = await this.user(req);
    await this.gate.assert(user, 'send', { ip: this.ip(req) });
    return ok(
      await this.gifts.start(user, {
        recipient: dto.recipient,
        amount: dto.amount,
        currency: dto.currency,
        roomId: dto.roomId ?? null,
      }),
    );
  }

  async confirmGift(
    req: FastifyRequest,
    giftId: string,
    dto: GiftConfirmDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.gifts.confirm(await this.user(req), giftId, dto.code));
  }

  async cancelGift(req: FastifyRequest, giftId: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.gifts.cancel(await this.user(req), giftId));
  }
}
