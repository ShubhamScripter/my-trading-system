import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { RainService } from './rain.service';

/** Prisma wraps PostgreSQL undefined_table (42P01) from raw SQL as P2010. */
export function isMissingRainTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; meta?: { code?: unknown; message?: unknown } };
  return value.code === 'P2010' && value.meta?.code === '42P01' &&
    typeof value.meta.message === 'string' && /\brain\.[a-z_][a-z0-9_]*\b/i.test(value.meta.message);
}

/** A short tick, not a queue. One pass at a time. Test runs do not start it. */
@Injectable()
export class RainScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RainScheduler');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private missingLogged = false;

  constructor(private readonly rain: RainService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.rain.tick();
    } catch (err: unknown) {
      if (isMissingRainTableError(err)) {
        if (!this.missingLogged) {
          this.missingLogged = true;
          this.logger.error('rain tables are missing; run db:migrate');
        }
        return;
      }
      this.logger.error({ err }, 'rain tick failed');
    } finally {
      this.running = false;
    }
  }
}
