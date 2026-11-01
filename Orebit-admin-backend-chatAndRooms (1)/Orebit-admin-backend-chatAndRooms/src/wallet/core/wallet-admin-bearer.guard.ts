import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { requirePrincipal } from '../../../auth/security/guards.js';
import { bearerFrom, verifyAccessToken } from '../../../auth/security/jwt.js';
import { ERR } from '../../contracts.js';
import { ProblemException } from '../../http.js';
import type { Principal } from '../../../auth/auth.types.js';

export type AdminBearerRequest = Readonly<{
  headers: Readonly<{ authorization?: string }>;
}>;

/** Requires the advertised Bearer credential and binds it to the global authenticated principal. */
export function requireBoundAdminBearer(request: AdminBearerRequest): Principal {
  const fastifyRequest = request as Parameters<typeof requirePrincipal>[0];
  const principal = requirePrincipal(fastifyRequest);
  const token = bearerFrom(request.headers.authorization);
  if (token === null) throw new ProblemException({ type: ERR.UNAUTHENTICATED });
  const claims = verifyAccessToken(token);
  if (claims.sub !== principal.adminId || claims.sid !== principal.sessionId
    || claims.rol !== principal.role) {
    throw new ProblemException({ type: ERR.TOKEN_INVALID });
  }
  return principal;
}

@Injectable()
export class WalletAdminBearerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    requireBoundAdminBearer(context.switchToHttp().getRequest<AdminBearerRequest>());
    return true;
  }
}
