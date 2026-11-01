import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config';
import { parseDto, ok, type SuccessEnvelope } from '../../http';
import { ChatAuthHelper } from '../chat/chat.auth.helper';
import { ChatBus } from '../chat/realtime/chat.bus';
import { clientIp } from '../chat/chat.utility';
import { ChatStaffGate } from '../chat/services/chat.staff.gate';
import { RAIN_STATUS_SCOPES, RainAdminService } from './rain.admin.service';
import { RainService } from './rain.service';

const ConfirmSchema = z
  .object({
    rainId: z.string().uuid(),
    totpCode: z.string().trim().max(12).optional(),
    emailCode: z.string().trim().max(12).optional(),
    /** The chosen option of each questionnaire question, in order. */
    answers: z.array(z.number().int().min(0).max(5)).max(10).optional(),
  })
  .strict();

const LimitSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).strict();
const RainIdSchema = z.object({ rainId: z.string().uuid() }).strict();

/** Chat staff: "Disable Overall / Rainpool / User Rains". ACT switches it; REPORT asks a higher role. */
const StatusSchema = z
  .object({
    scope: z.enum(['OVERALL', 'SYSTEM', 'USER']),
    status: z.enum(['ON', 'OFF']),
    /** REPORT mode: the requester's text box. */
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

/** parseDto, typed with the schema's output so defaulted fields are not optional. */
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  return parseDto(schema, body) as z.output<S>;
}

/**
 * Signed-in users: the rain state, limits, history, their own rains and the verification of a rain they started.
 * Chat staff: the three "Disable … Rains" switches. Everything else (settings, reviews, reverts) is the admin panel's.
 */
@Controller('social/rain')
export class RainRoutes {
  constructor(
    private readonly rain: RainService,
    private readonly admin: RainAdminService,
    private readonly auth: ChatAuthHelper,
    private readonly gate: ChatStaffGate,
    private readonly bus: ChatBus,
  ) { }

  // Countdown, the next pot, statuses and the user rain rules (signed-in users only).
  @Get('state')
  async state(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    await this.auth.getChatUser(req);
    return ok(await this.rain.publicState());
  }

  /** The minimum and maximum of one currency right now, in that currency. */
  @Get('limits')
  async limits(@Req() req: FastifyRequest, @Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    await this.auth.getChatUser(req);
    const { currency } = parseDto(z.object({ currency: z.string().trim().regex(/^[A-Za-z0-9]{2,10}$/) }).strict(), query);
    return ok(await this.rain.limits(currency));
  }

  @Get('history')
  async history(@Req() req: FastifyRequest, @Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    await this.auth.getChatUser(req);
    return ok(await this.rain.history(parse(LimitSchema, query).limit));
  }

  @Get('mine')
  async mine(@Req() req: FastifyRequest, @Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    return ok(await this.rain.mine(user.id, parse(LimitSchema, query).limit));
  }

  /** My rains waiting for me: codes, questionnaire or a KYC check (including what an admin requested). */
  @Get('pending')
  async pending(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    return ok(await this.rain.pending(user.id));
  }

  @Get('balances')
  async balances(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    return ok(await this.rain.balances(user.id));
  }

  @Post('confirm')
  @HttpCode(200)
  async confirm(@Req() req: FastifyRequest, @Body() body: unknown): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    return ok(await this.rain.confirm(user, parse(ConfirmSchema, body)));
  }

  @Post('resend-code')
  @HttpCode(200)
  async resendCode(@Req() req: FastifyRequest, @Body() body: unknown): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    const { rainId } = parseDto(RainIdSchema, body);
    return ok(await this.rain.resendCode(user, rainId, this.ip(req)));
  }

  @Post('cancel')
  @HttpCode(200)
  async cancel(@Req() req: FastifyRequest, @Body() body: unknown): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    const { rainId } = parseDto(RainIdSchema, body);
    return ok(await this.rain.cancel(user, rainId));
  }

  /** Stops one of my auto-repeat series. */
  @Post('repeats/cancel')
  @HttpCode(200)
  async cancelRepeat(@Req() req: FastifyRequest, @Body() body: unknown): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    const { repeatId } = parseDto(z.object({ repeatId: z.string().uuid() }).strict(), body);
    return ok(await this.rain.cancelRepeat(user, repeatId));
  }

  @Post('status')
  @HttpCode(200)
  async status(@Req() req: FastifyRequest, @Body() body: unknown): Promise<SuccessEnvelope<unknown>> {
    const user = await this.auth.getChatUser(req);
    const input = parse(StatusSchema, body);
    const permission = RAIN_STATUS_SCOPES[input.scope].permission;
    const mode = await this.gate.mode(user, permission);
    if (mode === 'REPORT') {
      return ok(
        await this.gate.report(user, permission, {
          payload: { status: input.status },
          note: input.note ?? `Please turn ${input.scope.toLowerCase()} rains ${input.status}`,
        }),
      );
    }
    const result = await this.admin.setStatus(input.scope, input.status, user.id);
    this.bus.publish({ kind: 'rain' });
    return ok(result);
  }

  private ip(req: FastifyRequest): string {
    return clientIp(req.headers['x-forwarded-for'], req.ip, config.trustedProxies);
  }
}
