// How long a staff ban may be (B-15, , ): permanent or a whole number of hours from 1, never both and never
// 0; at most the role's own maximum when acting (a request may ask up to the chat-wide maximum, the approver's limit
// applies then); only the chat ADMIN role bans without an end. One place, used by a ban of one user and of a group.
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import type { StaffRole } from '../chat.contract';
import { refuse } from '../chat.moderation.service';
import type { ChatSettings } from '../chat.settings.contract';
import { maxBanHoursFor } from './chat.permissions';

export function assertBanLength(
  settings: ChatSettings,
  role: StaffRole,
  mode: 'ACT' | 'REPORT',
  input: { permanent?: boolean; durationHours?: number },
): void {
  const permanent = input.permanent === true;
  if (permanent && input.durationHours !== undefined) {
    throw new ProblemException({
      type: ERR.VALIDATION_FAILED,
      errors: [{ path: 'permanent', message: 'Give permanent or durationHours, not both' }],
    });
  }
  const ceiling = mode === 'REPORT' ? settings.limits.maxBanHours : maxBanHoursFor(settings, role);
  if (!permanent) {
    const hours = input.durationHours;
    if (hours === undefined || !Number.isInteger(hours) || hours < 1 || hours > settings.limits.maxBanHours) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: 'durationHours',
            message: `A whole number of hours from 1 to ${settings.limits.maxBanHours}, or permanent: true`,
          },
        ],
      });
    }
    if (hours > ceiling) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.OUTSIDE_ROLE_SCOPE,
        `Your role may ban for at most ${ceiling} hours`,
        { maxBanHours: ceiling },
      );
    }
  } else if (mode === 'ACT' && role !== 'ADMIN') {
    // "Maximum Ban Duration": only the chat ADMIN role bans without an end.
    throw refuse(
      ERR.FORBIDDEN,
      CHAT_REFUSAL_REASONS.OUTSIDE_ROLE_SCOPE,
      'Only a chat admin may ban permanently',
      { maxBanHours: ceiling },
    );
  }
}
