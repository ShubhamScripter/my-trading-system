import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../../config';

/** Chat-only cache connection for presence, rate limits, and message spam windows. */
@Injectable()
export class ChatRedisService extends Redis implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ChatRedis');

  constructor() {
    super(config.chatRedisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    this.on('error', (err: Error) => this.logger.error({ err }, 'connection error'));
    await this.connect();
    this.logger.log('connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
