import {
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ERR } from '../../contracts';
import { CHAT_REFUSAL_REASONS } from './chat.constants';
import { refuse } from './chat.moderation.service';
import { ChatAuthHelper } from './chat.auth.helper';

const OPEN_TO_EVERY_USER = 'chat:staff:open-to-every-user';

// Marks a staff route that any signed-in user may call (the permissions read the chat UI makes for everyone).
export const OpenToEveryUser = (): MethodDecorator => SetMetadata(OPEN_TO_EVERY_USER, true);

// "Only staff reach the staff routes". A guard runs before the body pipe, so a user without a chat role gets
// 403 `permission_denied` whatever they send; before this the body was validated first and they got 400, which told
// a non-staff user which fields the staff routes take and made the answer depend on the body, not the caller.
// The role is read from the database through the chat user, never from the token.
@Injectable()
export class ChatStaffGuard implements CanActivate {
  constructor(
    private readonly auth: ChatAuthHelper,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.get<boolean>(OPEN_TO_EVERY_USER, context.getHandler())) return true;
    const user = await this.auth.getChatUser(context.switchToHttp().getRequest<FastifyRequest>());
    if (!user.staffRole) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.PERMISSION_DENIED,
        'Your chat role does not have this permission',
        {},
      );
    }
    return true;
  }
}
