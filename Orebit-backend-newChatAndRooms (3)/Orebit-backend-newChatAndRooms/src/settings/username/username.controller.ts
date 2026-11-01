import { Injectable } from '@nestjs/common';
import type { Principal } from '../../../auth/auth.types';
import { type SuccessEnvelope, ok, parseDto } from '../../http';
import {
  type UsernameAvailabilityPayload,
  type UsernameStatusPayload,
  type UsernameUpdatedPayload,
  usernameCheckQuerySchema,
  usernameUpdateSchema,
} from './username.dto';
import { UsernameService } from './username.service';

/**
 * The HTTP boundary for the username setting: parse, delegate, envelope.
 *
 * No branching worth the name, and that is the point rather than an accident. The
 * payment-PIN and email controllers switch on an `action` discriminant because those
 * features are ceremonies with several steps; this one has three operations that map
 * one-to-one onto three routes, so a discriminated union would be a union of one member
 * per route — ceremony without a ceremony.
 */
@Injectable()
export class UsernameController {
  constructor(private readonly username: UsernameService) {}

  async status(principal: Principal): Promise<SuccessEnvelope<UsernameStatusPayload>> {
    return ok(await this.username.status(principal.userId));
  }

  /**
   * The query object arrives as `unknown` and is parsed here, exactly like a body.
   *
   * Fastify hands query parameters over as strings with no schema, so the alternative
   * is a route handler reading `req.query.username` and trusting it — which is the one
   * place a `.strict()` schema is doing real work, because an unknown parameter here
   * would otherwise be silently accepted forever.
   */
  async check(
    query: unknown,
    principal: Principal,
  ): Promise<SuccessEnvelope<UsernameAvailabilityPayload>> {
    const input = parseDto(usernameCheckQuerySchema, query);
    return ok(await this.username.availability(principal.userId, input.username));
  }

  async update(
    body: unknown,
    principal: Principal,
  ): Promise<SuccessEnvelope<UsernameUpdatedPayload>> {
    const input = parseDto(usernameUpdateSchema, body);
    return ok(await this.username.update(principal.userId, input.username));
  }
}
