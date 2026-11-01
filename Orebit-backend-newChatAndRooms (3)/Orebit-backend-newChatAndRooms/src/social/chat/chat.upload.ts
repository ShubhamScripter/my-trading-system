import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { uuidv7 } from '../../utils/public.utils';
import type { UploadType } from './chat.contract';

/** The chat server's own public origin, for the chat media URLs it returns and accepts. Never the Host header. */
export function chatMediaBase(): string {
  const configured = process.env.CHAT_MEDIA_BASE_URL?.trim().replace(/\/+$/, '');
  return configured && configured.length > 0 ? configured : `http://localhost:${config.PORT}`;
}

/**
 * Chat uploads.
 *
 * `UPLOADS_DIR` and `UPLOADS_URL_PREFIX` stay exported, unchanged, because src/main.ts (not chat code) imports them
 * for its public static route. Chat no longer writes there: new files go to a PRIVATE folder (CHAT_UPLOADS_DIR,
 * default `storage/chat-media`, outside `uploads/`) and are served only by the signed-in chat media route, so an
 * upload is never a public file host. Nothing is created when this module loads — a read-only container
 * must still start; the folder is created with the first upload.
 */
export const UPLOADS_DIR = join(process.cwd(), 'uploads', 'chat-media');
export const UPLOADS_URL_PREFIX = '/uploads/chat-media/';

export function chatUploadsDir(): string {
  const configured = process.env.CHAT_UPLOADS_DIR?.trim();
  return configured && configured.length > 0
    ? configured
    : join(process.cwd(), 'storage', 'chat-media');
}

/** Off unless exactly `true`. Stays off in production until an NSFW scan and audited delete exist. */
export function uploadsEnabled(): boolean {
  return process.env.CHAT_UPLOADS_ENABLED === 'true';
}

export interface UploadedFilePart {
  mimetype: string;
  file: NodeJS.ReadableStream & { truncated?: boolean };
}

export class UnsupportedFileTypeError extends Error {}
export class FileTooLargeError extends Error {}
export class UploadStorageError extends Error {}

/** The real type, from the first bytes — never the label the client sent. */
export function sniffType(head: Buffer): UploadType | null {
  const b = head;
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 6 &&
    b
      .subarray(0, 6)
      .toString('latin1')
      .match(/^GIF8[79]a$/)
  )
    return 'image/gif';
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return 'video/webm';
  return null;
}

export interface SavedUpload {
  id: string;
  mimeType: UploadType;
  sizeBytes: number;
  sha256: string;
  /** The file name inside the private folder. */
  storageKey: string;
}

/** Counts, hashes and sniffs the stream as it is written, and stops at the size limit. */
class Inspector extends Transform {
  size = 0;
  head = Buffer.alloc(0);
  readonly hash = createHash('sha256');

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.size += chunk.length;
    if (this.size > this.maxBytes) {
      done(new FileTooLargeError(`File exceeds the maximum size of ${this.maxBytes} bytes`));
      return;
    }
    if (this.head.length < 16)
      this.head = Buffer.concat([this.head, chunk.subarray(0, 16 - this.head.length)]);
    this.hash.update(chunk);
    done(null, chunk);
  }
}

/**
 * Writes one uploaded file to the private folder. The type is decided by the file's first bytes and must be allowed
 * by the settings; any failure after writing starts removes the partly written file.
 */
export async function saveUpload(
  part: UploadedFilePart,
  limits: { maxBytes: number; allowedTypes: readonly UploadType[] },
): Promise<SavedUpload> {
  const dir = chatUploadsDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch (err: unknown) {
    throw new UploadStorageError((err as Error).message);
  }

  const id = uuidv7();
  const storageKey = `${id}.bin`;
  const path = join(dir, storageKey);
  const inspector = new Inspector(limits.maxBytes);

  try {
    await pipeline(part.file, inspector, createWriteStream(path, { flags: 'wx' }));
    if (part.file.truncated)
      throw new FileTooLargeError(`File exceeds the maximum size of ${limits.maxBytes} bytes`);
    const type = sniffType(inspector.head);
    if (type === null || !limits.allowedTypes.includes(type)) {
      throw new UnsupportedFileTypeError(`Allowed file types: ${limits.allowedTypes.join(', ')}`);
    }
    return {
      id,
      mimeType: type,
      sizeBytes: inspector.size,
      sha256: inspector.hash.digest('hex'),
      storageKey,
    };
  } catch (err: unknown) {
    await rm(path, { force: true }).catch(() => undefined);
    if (err instanceof FileTooLargeError || err instanceof UnsupportedFileTypeError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EROFS' || code === 'ENOSPC' || code === 'EPERM') {
      throw new UploadStorageError((err as Error).message);
    }
    throw err;
  }
}

export async function openUpload(
  storageKey: string,
): Promise<{ stream: Readable; size: number } | null> {
  if (!/^[0-9a-f-]{36}\.bin$/i.test(storageKey)) return null;
  const path = join(chatUploadsDir(), storageKey);
  try {
    const info = await stat(path);
    return { stream: createReadStream(path), size: info.size };
  } catch {
    return null;
  }
}

export async function removeUploadFile(storageKey: string): Promise<void> {
  if (!/^[0-9a-f-]{36}\.bin$/i.test(storageKey)) return;
  await rm(join(chatUploadsDir(), storageKey), { force: true });
}

// Signed media links
/** Links are valid for 6 to 7 hours: the expiry is rounded to the hour so the same link repeats and the browser caches it. */
const MEDIA_LINK_HOURS = 6;

function mediaSignature(mediaId: string, exp: number): string {
  return createHmac('sha256', config.rateLimitKeySecret)
    .update(`chat-media:${mediaId}:${exp}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Adds a signature to a chat media link, so an <img> loads it without the session cookie having to be refreshed on
 * that request. Only people who may view the message receive the link. Other URLs (GIF hosts) are returned as is.
 * The expiry is a cache timer that is never stored or shown (like the presence timers).
 */
export function signMediaUrl(url: string): string {
  const match = /\/social\/chat\/media\/([0-9a-f-]{36})$/i.exec(url.split('?')[0] ?? '');
  if (!match) return url;
  const hour = 3600;
  const exp = (Math.floor(Date.now() / 1000 / hour) + 1 + MEDIA_LINK_HOURS) * hour;
  return `${url.split('?')[0]}?exp=${exp}&sig=${mediaSignature(match[1]!.toLowerCase(), exp)}`;
}

/** Whether a media link's signature is valid and not expired. */
export function mediaLinkValid(
  mediaId: string,
  exp: string | undefined,
  sig: string | undefined,
): boolean {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{32}$/.test(sig)) return false;
  const expires = Number(exp);
  if (expires * 1000 < Date.now()) return false;
  const expected = mediaSignature(mediaId.toLowerCase(), expires);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
