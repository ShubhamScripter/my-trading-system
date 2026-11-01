import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../../../auth/security/jwt';
import { requirePrincipal } from '../../../auth/security/guards';
import { SessionService } from '../../../auth/services/session.service';
import { KEYS, RedisService } from '../../../redis';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { HANDSHAKE_REFUSALS } from './chat.constants';
import { ChatDbOperation } from './chat.dboperation';
import { allowedOrigins, ChatSessionAdapter, HandshakeRefusal } from './chat.session.adapter';
import type { ChatUserContext } from './chat.types';

const MGET_CHUNK = 1000;

/** Authenticates HTTP requests and WebSocket handshakes using active session cookies. */
@Injectable()
export class ChatAuthHelper {
  private readonly logger = new Logger('ChatAuthHelper');

  constructor(
    private readonly db: ChatDbOperation,
    private readonly sessions: SessionService,
    private readonly adapter: ChatSessionAdapter,
    private readonly redis: RedisService,
  ) {}

  async resolveChatUser(userId: string): Promise<ChatUserContext | null> {
    return this.db.findChatUser(userId);
  }

  /** The chat user behind an authenticated HTTP request; a disabled or deleted account gets 401. */
  async getChatUser(req: FastifyRequest): Promise<ChatUserContext> {
    const principal = requirePrincipal(req);
    const user = await this.db.findChatUser(principal.userId);
    if (!user) {
      throw new ProblemException({
        type: ERR.UNAUTHENTICATED,
        detail: 'This account cannot use chat',
      });
    }
    return user;
  }

  /**
   * The socket handshake. Throws a HandshakeRefusal whose reason the client acts on: sign in again
   * (`unauthenticated`), refresh then reconnect (`session_refresh_required`), retry with back-off
   * (`session_store_unavailable`), or fix the page (`origin_not_allowed`).
   */
  async authenticateHandshake(headers: Record<string, string | string[] | undefined>): Promise<{
    user: ChatUserContext;
    sessionId: string;
    familyId: string;
  }> {
    const origin = typeof headers.origin === 'string' ? headers.origin.replace(/\/+$/, '') : null;
    if (origin === null || !allowedOrigins().includes(origin)) {
      throw new HandshakeRefusal(HANDSHAKE_REFUSALS.ORIGIN_NOT_ALLOWED);
    }

    const cookie = typeof headers.cookie === 'string' ? headers.cookie : undefined;
    const record = await this.adapter.resolve(cookie);

    let claims: { sub: string; sid: string };
    try {
      claims = verifyAccessToken(record.accessToken);
    } catch (err: unknown) {
      if (err instanceof ProblemException && err.type === ERR.TOKEN_EXPIRED) {
        throw new HandshakeRefusal(HANDSHAKE_REFUSALS.SESSION_REFRESH_REQUIRED);
      }
      throw new HandshakeRefusal(HANDSHAKE_REFUSALS.UNAUTHENTICATED);
    }

    let familyId: string;
    try {
      const live = await this.sessions.assertLive(claims.sid);
      familyId = typeof live === 'string' ? live : (live as { familyId: string }).familyId;
    } catch (err: unknown) {
      if (err instanceof ProblemException)
        throw new HandshakeRefusal(HANDSHAKE_REFUSALS.UNAUTHENTICATED);
      throw new HandshakeRefusal(HANDSHAKE_REFUSALS.SESSION_STORE_UNAVAILABLE);
    }

    // The session family and the account, on the database clock, in one query that also returns now().
    const { live, dbNow } = await this.db.sessionLive(familyId, claims.sub);
    if (!live) throw new HandshakeRefusal(HANDSHAKE_REFUSALS.UNAUTHENTICATED);
    if (this.adapter.isDueForRefresh(record, dbNow.getTime())) {
      throw new HandshakeRefusal(HANDSHAKE_REFUSALS.SESSION_REFRESH_REQUIRED);
    }

    const user = await this.db.findChatUser(claims.sub);
    if (!user) throw new HandshakeRefusal(HANDSHAKE_REFUSALS.UNAUTHENTICATED);
    return { user, sessionId: claims.sid, familyId };
  }

  /**
   * Which of the given sessions the auth has flagged revoked, from `session:revoked:<id>` (the shared key builder),
   * with MGET in chunks of 1,000. Throws on a Redis error: the caller keeps every socket.
   */
  async revokedSessions(sessionIds: readonly string[]): Promise<Set<string>> {
    const revoked = new Set<string>();
    for (let i = 0; i < sessionIds.length; i += MGET_CHUNK) {
      const chunk = sessionIds.slice(i, i + MGET_CHUNK);
      const values = await this.redis.mget(...chunk.map((id) => KEYS.session.revoked(id)));
      values.forEach((value, index) => {
        if (value !== null && value !== '0' && value !== 'false') revoked.add(chunk[index]!);
      });
    }
    return revoked;
  }

  /** Families that are definitely not live, 1,000 per statement. Throws on a database error. */
  async deadFamilies(familyIds: readonly string[]): Promise<Set<string>> {
    const dead = new Set<string>();
    for (let i = 0; i < familyIds.length; i += MGET_CHUNK) {
      for (const family of await this.db.deadFamilies(familyIds.slice(i, i + MGET_CHUNK)))
        dead.add(family);
    }
    return dead;
  }
}
