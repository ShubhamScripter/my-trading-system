import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileTooLargeError,
  mediaLinkValid,
  signMediaUrl,
  UnsupportedFileTypeError,
  saveUpload,
  sniffType,
  uploadsEnabled,
} from '../../src/social/chat/chat.upload';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
]);
const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const part = (bytes: Buffer, label = 'image/png') => ({
  mimetype: label,
  file: Readable.from([bytes]) as never,
});

describe('chat uploads', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-upload-'));
    process.env.CHAT_UPLOADS_DIR = join(dir, 'media');
  });
  afterEach(() => {
    delete process.env.CHAT_UPLOADS_DIR;
    delete process.env.CHAT_UPLOADS_ENABLED;
    rmSync(dir, { recursive: true, force: true });
  });

  it('loading the module creates no folder', () => {
    expect(existsSync(join(dir, 'media'))).toBe(false);
  });

  it('is off unless CHAT_UPLOADS_ENABLED is exactly true', () => {
    expect(uploadsEnabled()).toBe(false);
    process.env.CHAT_UPLOADS_ENABLED = 'TRUE';
    expect(uploadsEnabled()).toBe(false);
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    expect(uploadsEnabled()).toBe(true);
  });

  it('decides the type from the first bytes, never the label', () => {
    expect(sniffType(PNG)).toBe('image/png');
    expect(sniffType(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });

  it('saves a real image into the private folder with its hash', async () => {
    const saved = await saveUpload(part(Buffer.concat([PNG, Buffer.alloc(100)])), {
      maxBytes: 1024,
      allowedTypes: IMAGES,
    });
    expect(saved).toMatchObject({ mimeType: 'image/png', sizeBytes: 116 });
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(join(dir, 'media'))).toEqual([saved.storageKey]);
  });

  it('a non-image labelled image/png is refused and leaves no file', async () => {
    await expect(
      saveUpload(part(Buffer.from('not an image at all')), {
        maxBytes: 1024,
        allowedTypes: IMAGES,
      }),
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);
    expect(readdirSync(join(dir, 'media'))).toEqual([]);
  });

  it('an oversize file is refused and leaves no file', async () => {
    await expect(
      saveUpload(part(Buffer.concat([PNG, Buffer.alloc(2048)])), {
        maxBytes: 1024,
        allowedTypes: IMAGES,
      }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
    expect(readdirSync(join(dir, 'media'))).toEqual([]);
  });

  it('video is refused while the settings allow images only', async () => {
    const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    await expect(
      saveUpload(part(mp4, 'video/mp4'), { maxBytes: 1024, allowedTypes: IMAGES }),
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });
});

describe('signed media links', () => {
  const id = '0192f6a0-0000-7000-8000-00000000aa01';
  const url = `http://localhost:3005/social/chat/media/${id}`;

  it('signs a chat upload link and accepts its own signature', () => {
    const signed = new URL(signMediaUrl(url));
    expect(
      mediaLinkValid(
        id,
        signed.searchParams.get('exp') ?? undefined,
        signed.searchParams.get('sig') ?? undefined,
      ),
    ).toBe(true);
  });

  it('refuses a missing, tampered or expired signature', () => {
    const signed = new URL(signMediaUrl(url));
    const exp = signed.searchParams.get('exp') ?? '';
    expect(mediaLinkValid(id, undefined, undefined)).toBe(false);
    expect(mediaLinkValid(id, exp, '0'.repeat(32))).toBe(false);
    expect(
      mediaLinkValid(
        '0192f6a0-0000-7000-8000-00000000aa02',
        exp,
        signed.searchParams.get('sig') ?? '',
      ),
    ).toBe(false);
    expect(mediaLinkValid(id, '1000', signed.searchParams.get('sig') ?? '')).toBe(false);
  });

  it('leaves GIF links unchanged', () => {
    expect(signMediaUrl('https://media.tenor.com/abc/tenor.gif')).toBe(
      'https://media.tenor.com/abc/tenor.gif',
    );
  });
});
