/** The support chat over HTTP (Module 10). Paths are in support.routes.ts. */
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ok, type SuccessEnvelope } from '../../../http';
import { ChatAuthHelper } from '../chat.auth.helper';
import type * as dto from './support.dto';
import { ChatSupportService } from './support.service';

@Injectable()
export class SupportController {
  constructor(
    private readonly auth: ChatAuthHelper,
    private readonly support: ChatSupportService,
  ) {}

  async open(req: FastifyRequest, body: dto.SupportCreateDto): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.support.open(await this.auth.getChatUser(req), body));
  }

  async list(
    req: FastifyRequest,
    query: dto.SupportListQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.support.list(await this.auth.getChatUser(req), query));
  }

  async get(
    req: FastifyRequest,
    ticketId: string,
    query: dto.SupportMessagesQueryDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.support.get(await this.auth.getChatUser(req), ticketId, query));
  }

  async post(
    req: FastifyRequest,
    ticketId: string,
    body: dto.SupportMessageDto,
  ): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.support.post(await this.auth.getChatUser(req), ticketId, body));
  }

  async close(req: FastifyRequest, ticketId: string): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.support.close(await this.auth.getChatUser(req), ticketId));
  }
}
