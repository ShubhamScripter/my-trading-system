import { Injectable } from '@nestjs/common';
import type { StaffPermission } from '../chat/chat.features.contract';
import type { RainStatus } from './rain.contract';
import { RainDbOperation } from './rain.dboperation';

/** Which status a chat staff permission switches (Chat SETTINGS "Moderation Role Permissions"). */
export const RAIN_STATUS_SCOPES = {
  /** "Disable Overall Rains (Neither user nor rainpool can rain)". */
  OVERALL: { permission: 'DISABLE_OVERALL_RAINS', field: 'overall' },
  /** "Disable Rainpool Rains". */
  SYSTEM: { permission: 'DISABLE_RAINPOOL_RAINS', field: 'system' },
  /** "Disable User Rains". */
  USER: { permission: 'DISABLE_USER_RAINS', field: 'user' },
} as const satisfies Record<string, { permission: StaffPermission; field: 'overall' | 'system' | 'user' }>;
export type RainStatusScope = keyof typeof RAIN_STATUS_SCOPES;

export function scopeOfPermission(permission: string): RainStatusScope | null {
  for (const [scope, entry] of Object.entries(RAIN_STATUS_SCOPES)) {
    if (entry.permission === permission) return scope as RainStatusScope;
  }
  return null;
}

/**
 * What chat staff may change about rain: the three "Disable … Rains" switches, nothing else. The RainPool settings,
 * reviews and reverts belong to the admin panel (admin backend).
 */
@Injectable()
export class RainAdminService {
  constructor(private readonly db: RainDbOperation) {}

  async setStatus(
    scope: RainStatusScope,
    status: Extract<RainStatus, 'ON' | 'OFF'>,
    actorId: string,
  ): Promise<{ scope: RainStatusScope; status: RainStatus }> {
    const field = RAIN_STATUS_SCOPES[scope].field;
    const { before, after } = await this.db.patchStatus({ [field]: status });
    await this.db.audit({
      actorType: 'STAFF',
      actorId,
      action: 'STATUS_CHANGED',
      detail: { scope, before, after },
    });
    return { scope, status };
  }
}
