import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/client';
import { RedisService } from '../redis';
import { config } from './config';

export interface HealthResponse {
  readonly status: 'ok';
  readonly env: string;
}

export interface ReadinessResponse {
  readonly status: 'ready' | 'degraded';
  readonly checks: {
    readonly database: 'up' | 'down';
    readonly redis: 'up' | 'down';
  };
}

/**
 * App-level concerns. Health and readiness are deliberately separate:
 *
 * `/health` answers "is this process alive" and must never touch a dependency —
 * a load balancer that kills the process because Postgres blinked turns one
 * outage into two.
 *
 * `/readiness` answers "can this process serve traffic" and therefore does check
 * dependencies. That is the one a deploy gate should read.
 */
@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  health(): HealthResponse {
    return { status: 'ok', env: config.NODE_ENV };
  }

  async readiness(): Promise<ReadinessResponse> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return {
      status: database === 'up' && redis === 'up' ? 'ready' : 'degraded',
      checks: { database, redis },
    };
  }

  private async checkDatabase(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<'up' | 'down'> {
    try {
      return (await this.redis.ping()) === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
