import { describe, expect, it } from 'vitest';
import type { ArgumentMetadata } from '@nestjs/common';
import { ProblemException } from '../../src/http';
import {
  BanUserDto,
  GetMessagesQueryDto,
  ReportDto,
  SendMediaMessageDto,
  SendMessageDto,
  UpdateChatPreferenceDto,
} from '../../src/social/chat/chat.dto';
import { WsValidationPipe } from '../../src/social/chat/chat.ws.pipe';

const pipe = new WsValidationPipe();
const as = (metatype: unknown, type: ArgumentMetadata['type'] = 'body'): ArgumentMetadata =>
  ({ metatype, type }) as ArgumentMetadata;

function refused(run: () => unknown): { type: string; paths: string[] } {
  try {
    run();
  } catch (err) {
    if (err instanceof ProblemException)
      return { type: err.type, paths: (err.errors ?? []).map((e) => e.path) };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('WsValidationPipe', () => {
  it('refuses unknown fields instead of dropping them', () => {
    expect(
      refused(() => pipe.transform({ content: 'hi', hideIdentity: true }, as(SendMessageDto))),
    ).toEqual({
      type: 'validation_failed',
      paths: ['hideIdentity'],
    });
  });

  it('refuses a client-chosen message type and metadata', () => {
    expect(
      refused(() => pipe.transform({ content: 'hi', type: 'ADMIN_ALERT' }, as(SendMessageDto)))
        .paths,
    ).toContain('type');
    expect(
      refused(() => pipe.transform({ content: 'hi', metadata: {} }, as(SendMessageDto))).paths,
    ).toContain('metadata');
  });

  it('accepts 4,000 characters and refuses 4,001', () => {
    expect(() => pipe.transform({ content: '"'.repeat(4000) }, as(SendMessageDto))).not.toThrow();
    expect(
      refused(() => pipe.transform({ content: '"'.repeat(4001) }, as(SendMessageDto))).paths,
    ).toEqual(['content']);
  });

  it('refuses empty text', () => {
    expect(refused(() => pipe.transform({ content: '   ' }, as(SendMessageDto))).paths).toEqual([
      'content',
    ]);
  });

  it('caps media URLs at 2,048 characters', () => {
    const url = `https://media.tenor.com/${'a'.repeat(2030)}`;
    expect(
      refused(() =>
        pipe.transform(
          { roomId: 'global', mediaUrl: url, mediaType: 'gif' },
          as(SendMediaMessageDto),
        ),
      ).paths,
    ).toEqual(['mediaUrl']);
  });

  it.each([['101'], ['0'], ['-1'], ['abc']])('refuses limit=%s', (limit) => {
    expect([
      ...new Set(refused(() => pipe.transform({ limit }, as(GetMessagesQueryDto, 'query'))).paths),
    ]).toEqual(['limit']);
  });

  it('converts a valid limit and allows no query at all', () => {
    expect(pipe.transform({ limit: '50' }, as(GetMessagesQueryDto, 'query'))).toMatchObject({
      limit: 50,
    });
    expect(pipe.transform(undefined, as(GetMessagesQueryDto, 'query'))).toBeInstanceOf(
      GetMessagesQueryDto,
    );
  });

  it('refuses a malformed report reason and a ban of 0 or negative hours', () => {
    expect(refused(() => pipe.transform({ reason: 'foo' }, as(ReportDto))).paths).toEqual([
      'reason',
    ]);
    const ban = { userId: '0192f6a0-0000-7000-8000-000000000001', internalReason: 'x' };
    expect(
      refused(() => pipe.transform({ ...ban, durationHours: 0 }, as(BanUserDto))).paths,
    ).toEqual(['durationHours']);
    expect(
      refused(() => pipe.transform({ ...ban, durationHours: -5 }, as(BanUserDto))).paths,
    ).toEqual(['durationHours']);
    expect(() => pipe.transform({ ...ban, permanent: true }, as(BanUserDto))).not.toThrow();
  });

  it('refuses removed preference fields', () => {
    expect(
      refused(() => pipe.transform({ quietMode: true }, as(UpdateChatPreferenceDto))).paths,
    ).toEqual(['quietMode']);
    expect(
      refused(() => pipe.transform({ defaultRoomId: 'global' }, as(UpdateChatPreferenceDto))).paths,
    ).toEqual(['defaultRoomId']);
  });
});
