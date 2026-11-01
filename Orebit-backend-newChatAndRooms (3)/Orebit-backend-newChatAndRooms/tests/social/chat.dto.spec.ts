import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { LIMITS, PAGE } from '../../src/social/chat/chat.constants';
import {
  JoinRoomDto,
  OnlineUsersDto,
  PageQueryDto,
  ReportDto,
  RetractMessageDto,
  SendMessageDto,
  UpdateChatPreferenceDto,
} from '../../src/social/chat/chat.dto';

/** The class-validator problems of `plain` as a DTO, as "field" names; empty when it is valid. */
async function problems<T extends object>(cls: new () => T, plain: object): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: false,
    forbidUnknownValues: true,
  });
  return errors.map((e) => e.property).sort();
}

const UUID = '0192f6a0-0000-7000-8000-00000000aa01';
// The ids of seeded rows (the Global room, the default skin) are not RFC versions, and must still be accepted.
const SEEDED_UUID = '00000000-0000-0000-0000-000000000001';

describe('SendMessageDto', () => {
  it('accepts plain text', async () => {
    expect(await problems(SendMessageDto, { content: 'hello' })).toEqual([]);
  });

  it('trims the text before measuring it', async () => {
    const dto = plainToInstance(SendMessageDto, { content: '  hi  ' });
    expect(dto.content).toBe('hi');
  });

  it('refuses empty text and text over the limit', async () => {
    expect(await problems(SendMessageDto, { content: '   ' })).toEqual(['content']);
    expect(
      await problems(SendMessageDto, { content: 'x'.repeat(LIMITS.MESSAGE_CHARS + 1) }),
    ).toEqual(['content']);
  });

  it('needs text unless there is media; media needs a known type', async () => {
    expect(await problems(SendMessageDto, {})).toEqual(['content']);
    expect(
      await problems(SendMessageDto, { mediaUrl: 'https://x/y.png', mediaType: 'image' }),
    ).toEqual([]);
    expect(await problems(SendMessageDto, { mediaUrl: 'https://x/y.png' })).toEqual(['mediaType']);
    expect(
      await problems(SendMessageDto, { mediaUrl: 'https://x/y.png', mediaType: 'audio' }),
    ).toEqual(['mediaType']);
  });

  it('accepts the fixed ids of seeded rows as a skin and a retry id', async () => {
    expect(
      await problems(SendMessageDto, {
        content: 'hi',
        skinId: SEEDED_UUID,
        clientMessageId: UUID,
      }),
    ).toEqual([]);
    expect(await problems(SendMessageDto, { content: 'hi', skinId: 'not-a-uuid' })).toEqual([
      'skinId',
    ]);
  });
});

describe('RetractMessageDto and JoinRoomDto', () => {
  it('needs a message id', async () => {
    expect(await problems(RetractMessageDto, { messageId: UUID })).toEqual([]);
    expect(await problems(RetractMessageDto, { messageId: '12' })).toEqual(['messageId']);
  });

  it('takes a room by id or slug, within the length limit', async () => {
    expect(await problems(JoinRoomDto, { roomId: 'global' })).toEqual([]);
    expect(await problems(JoinRoomDto, { roomId: '' })).toEqual(['roomId']);
    expect(await problems(JoinRoomDto, { roomId: 'r'.repeat(LIMITS.ROOM_REF_CHARS + 1) })).toEqual([
      'roomId',
    ]);
  });
});

describe('page queries', () => {
  it('turns a query-string limit into a number and bounds it', async () => {
    expect(plainToInstance(PageQueryDto, { limit: '20' }).limit).toBe(20);
    expect(await problems(PageQueryDto, { limit: '20' })).toEqual([]);
    expect(await problems(PageQueryDto, { limit: '0' })).toEqual(['limit']);
    expect(await problems(PageQueryDto, { limit: String(PAGE.MAX + 1) })).toEqual(['limit']);
  });

  it('keeps the member search prefix short', async () => {
    expect(await problems(OnlineUsersDto, { prefix: 'ab' })).toEqual([]);
    expect(await problems(OnlineUsersDto, { prefix: 'x'.repeat(25) })).toEqual(['prefix']);
  });
});

describe('preferences and reports', () => {
  it('lets a user clear the active skin with null but not set a bad one', async () => {
    expect(await problems(UpdateChatPreferenceDto, { activeSkinId: null })).toEqual([]);
    expect(await problems(UpdateChatPreferenceDto, { activeSkinId: 'nope' })).toEqual([
      'activeSkinId',
    ]);
    expect(await problems(UpdateChatPreferenceDto, { hideIdentity: 'yes' })).toEqual([
      'hideIdentity',
    ]);
  });

  it('needs a reason and a bounded detail text', async () => {
    expect(await problems(ReportDto, { reason: 'SPAM' })).toEqual([]);
    expect(await problems(ReportDto, { reason: 'SPAM', details: 'd'.repeat(1001) })).toEqual([
      'details',
    ]);
    expect(await problems(ReportDto, {})).toContain('reason');
  });
});
