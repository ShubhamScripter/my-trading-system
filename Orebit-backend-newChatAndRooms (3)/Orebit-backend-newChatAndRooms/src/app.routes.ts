import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/security/guards';
import { AppService, type HealthResponse, type ReadinessResponse } from './app.service';
import { ok, type SuccessEnvelope } from './http';

/**
 * Root routes. Declarative and logic-free, like every other `*.routes.ts` —
 * they extract what the framework can extract and delegate.
 *
 * `@Public()` on the class: both routes are probes, and a load balancer or an
 * orchestrator has no credential to offer. A readiness check that could return 401
 * would take the service out of rotation for being healthy.
 */
@Public()
@Controller()
export class AppRoutes {
  constructor(private readonly service: AppService) {}

  @Get('health')
  health(): SuccessEnvelope<HealthResponse> {
    return ok(this.service.health());
  }

  @Get('readiness')
  async readiness(): Promise<SuccessEnvelope<ReadinessResponse>> {
    return ok(await this.service.readiness());
  }
}

/**
 * The route-group registry: every URL prefix this service answers on, and the
 * module that owns it.
 *
 * Nest derives routing from `@Controller` decorators, so this table does not
 * *drive* anything — it is documentation that a test can assert against
 * (tests/app.routes.spec.ts), which is the closest thing to a mechanical check
 * available without a dependency-graph linter. Add a module, add a row.
 */
export const ROUTE_GROUPS = [
  { prefix: '', module: 'app', description: 'health and readiness' },
  {
    prefix: 'auth',
    module: 'auth',
    description: 'registration, login, sessions, devices, account and profile',
  },
  {
    // Under the `auth` prefix on the wire and in its own module in the tree — see
    // the header of src/2fa/2fa.routes.ts for why those two decisions differ.
    prefix: 'auth/2fa',
    module: '2fa',
    description: 'second factor: enrollment, sign-in ceremony, re-authentication',
  },
  {
    prefix: 'settings',
    module: 'settings',
    description:
      'user settings: the second factors, the Payment PIN, the email address, the ' +
      'username, the password, the anti-phishing code and the account itself, as ' +
      "switches and values the account's owner controls",
  },
  {
    prefix: 'social',
    module: 'social',
    description: 'chat rooms, real-time messaging, presence, preferences',
  },
] as const;
