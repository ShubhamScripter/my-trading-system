import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_SETTINGS,
  type ChatSettings,
} from '../../src/social/chat/chat.settings.contract';
import {
  assertAvailable,
  assertPublicChatOpen,
  autoModerationActive,
  availabilityRefusal,
} from '../../src/social/chat/services/chat.availability';

type Status = 'ACTIVE' | 'MAINTENANCE' | 'DISABLED';

function settings(
  patch: Partial<Record<keyof ChatSettings['maintenance'], Status | string | null>>,
) {
  return {
    ...DEFAULT_CHAT_SETTINGS,
    maintenance: { ...DEFAULT_CHAT_SETTINGS.maintenance, ...patch },
  } as unknown as ChatSettings;
}

describe('chat availability (Chat SETTINGS "ON / OFF / MAINTENANCE")', () => {
  it('lets everything through while ACTIVE', () => {
    expect(availabilityRefusal(settings({}), 'chat', true)).toBeNull();
    expect(availabilityRefusal(settings({}), 'ads', true)).toBeNull();
  });

  it('MAINTENANCE lets users read but refuses writes, with the admin note', () => {
    const s = settings({ publicChat: 'MAINTENANCE', note: 'Back at 18:00' });
    expect(availabilityRefusal(s, 'publicChat', false)).toBeNull();
    const refusal = availabilityRefusal(s, 'publicChat', true);
    expect(refusal).not.toBeNull();
    expect(refusal?.extra?.reason).toBe('feature_maintenance');
    expect(refusal?.detail).toBe('Back at 18:00');
  });

  it('DISABLED refuses reads and writes', () => {
    const s = settings({ skins: 'DISABLED' });
    expect(availabilityRefusal(s, 'skins', false)).not.toBeNull();
    expect(() => assertAvailable(s, 'skins', true)).toThrow();
  });

  it('public chat needs both the whole of chat and public chat open', () => {
    expect(() => assertPublicChatOpen(settings({}), true)).not.toThrow();
    expect(() => assertPublicChatOpen(settings({ chat: 'MAINTENANCE' }), true)).toThrow();
    expect(() => assertPublicChatOpen(settings({ chat: 'MAINTENANCE' }), false)).not.toThrow();
    expect(() => assertPublicChatOpen(settings({ publicChat: 'DISABLED' }), false)).toThrow();
  });

  it('an automatic moderation check runs only while ACTIVE', () => {
    const s = settings({
      autoModLinks: 'MAINTENANCE',
      autoModWords: 'DISABLED',
    });
    expect(autoModerationActive(s, 'autoModLinks')).toBe(false);
    expect(autoModerationActive(s, 'autoModWords')).toBe(false);
    expect(autoModerationActive(s, 'autoModSpam')).toBe(true);
  });
});
