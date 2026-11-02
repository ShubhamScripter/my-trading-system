// The limiter for chat actions that are not messages: mute, block, ad quote, ad create, gift start (rulebook C.4;
// ). One user may do one kind of action `max` times in `windowSeconds`; the next attempt starts a cooldown of
// `cooldownSeconds`. The numbers are the admin's chat limits (messagesPerWindow, messageWindowSeconds, cooldownSeconds);
// there is no number in this file.
// Redis holds the counter (atomic INCR, so parallel requests cannot all pass the last place). While Redis is down the
// granted in-process fallback takes over: the same rule on a steady clock, never "no limit".
import { Injectable, Logger } from '@nestjs/common';
import { ChatRedisService } from '../chat.redis';

export interface LimitRule {
  readonly max: number;
  readonly windowSeconds: number;
  readonly cooldownSeconds: number;
}

interface LocalState {
  windowStart: number;
  count: number;
  cooldownUntil: number;
}

const LOCAL_MAX = 50_000;

@Injectable()
export class ChatActionLimiter {
  private readonly logger = new Logger('ChatActionLimiter');
  private readonly local = new Map<string, LocalState>();
  private warned = false;

  constructor(private readonly redis: ChatRedisService) {}

  // 0 when the action may go on (and is counted), else the seconds to wait.
  async hit(key: string, rule: LimitRule): Promise<number> {
    try {
      return await this.hitRedis(key, rule);
    } catch (err: unknown) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn({ err }, 'Redis is not answering: chat action limits run in this process');
      }
      return this.hitLocal(key, rule);
    }
  }

  private async hitRedis(key: string, rule: LimitRule): Promise<number> {
    const cooldownKey = `${key}:cd`;
    const cooling = await this.redis.pttl(cooldownKey);
    if (cooling > 0) return Math.max(1, Math.ceil(cooling / 1000));
    const count = await this.redis.incr(key);
    if (count === 1 || (await this.redis.pttl(key)) < 0) {
      await this.redis.pexpire(key, rule.windowSeconds * 1000);
    }
    if (count <= rule.max) return 0;
    await this.redis.set(cooldownKey, '1', 'PX', rule.cooldownSeconds * 1000);
    return rule.cooldownSeconds;
  }

  private hitLocal(key: string, rule: LimitRule): number {
    const now = performance.now();
    let state = this.local.get(key);
    if (!state) {
      if (this.local.size >= LOCAL_MAX) this.local.delete(this.local.keys().next().value as string);
      state = { windowStart: now, count: 0, cooldownUntil: 0 };
      this.local.set(key, state);
    }
    if (state.cooldownUntil > now) return Math.max(1, Math.ceil((state.cooldownUntil - now) / 1000));
    if (now - state.windowStart >= rule.windowSeconds * 1000) {
      state.windowStart = now;
      state.count = 0;
    }
    state.count += 1;
    if (state.count <= rule.max) return 0;
    state.cooldownUntil = now + rule.cooldownSeconds * 1000;
    return rule.cooldownSeconds;
  }
}
