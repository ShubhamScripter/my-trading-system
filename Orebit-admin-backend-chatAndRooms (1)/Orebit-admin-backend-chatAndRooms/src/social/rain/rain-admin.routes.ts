import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { requirePrincipal, SuperAdminGuard } from '../../../auth/security/guards';
import { ok, type SuccessEnvelope } from '../../http';
import { RainAdminService } from './rain-admin.service';

@Controller('social/rain')
export class RainAdminRoutes {
  constructor(private readonly rain: RainAdminService) {}

  private admin(req: FastifyRequest): string {
    return requirePrincipal(req).adminId;
  }

  // RainPool settings
  @Get('settings')
  async settings(): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.settings());
  }

  @Post('settings')
  @HttpCode(200)
  @UseGuards(SuperAdminGuard)
  async saveSettings(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.saveSettings(body, this.admin(req)));
  }

  // Returns next rain countdown, currency, pot, and queue counts
  @Get('state')
  async state(): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.state());
  }

  // Status updates
  @Post('status')
  @HttpCode(200)
  @UseGuards(SuperAdminGuard)
  async setStatus(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.setStatus(body, this.admin(req)));
  }

  @Get('status/scheduled')
  async scheduled(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.scheduledStatus(query));
  }

  @Post('status/schedule')
  @HttpCode(201)
  @UseGuards(SuperAdminGuard)
  async schedule(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.scheduleStatus(body, this.admin(req)));
  }

  @Post('status/schedule/cancel')
  @HttpCode(200)
  @UseGuards(SuperAdminGuard)
  async cancelSchedule(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.cancelScheduledStatus(body, this.admin(req)));
  }

  // Rain runs history
  @Get('rains')
  async rains(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.rains(query));
  }

  @Get('rains/detail')
  async detail(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.rain(query));
  }

  // Admin verification reviews
  @Get('reviews')
  async reviews(): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.reviews());
  }

  @Post('reviews/approve')
  @HttpCode(200)
  async approve(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.approve(body, this.admin(req)));
  }

  @Post('reviews/reject')
  @HttpCode(200)
  async reject(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.reject(body, this.admin(req)));
  }

  @Post('reviews/request')
  @HttpCode(200)
  async request(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.requestVerification(body, this.admin(req)));
  }

  // Revert operations
  @Post('revert')
  @HttpCode(200)
  async revert(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.revert(body, this.admin(req)));
  }

  @Post('revert/bulk')
  @HttpCode(200)
  async revertBulk(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.revertBulk(body, this.admin(req)));
  }

  // Trigger, jobs, and series
  @Post('trigger')
  @HttpCode(200)
  async trigger(@Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.trigger(this.admin(req)));
  }

  @Get('jobs')
  async jobs(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.jobs(query));
  }

  @Get('repeats')
  async repeats(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.repeats(query));
  }

  @Post('repeats/cancel')
  @HttpCode(200)
  async cancelRepeat(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.cancelRepeat(body, this.admin(req)));
  }

  @Get('audit')
  async audit(@Query() query: unknown): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.auditLog(query));
  }

  // Dev pricing
  @Get('dev-prices')
  async devPrices(): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.devPrices());
  }

  @Post('dev-prices')
  @HttpCode(200)
  @UseGuards(SuperAdminGuard)
  async setDevPrices(@Body() body: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<unknown>> {
    return ok(await this.rain.setDevPrices(body, this.admin(req)));
  }
}
