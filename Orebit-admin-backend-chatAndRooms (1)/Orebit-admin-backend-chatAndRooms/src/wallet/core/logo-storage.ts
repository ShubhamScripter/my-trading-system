import { randomBytes } from 'node:crypto';
import {
  link as nodeLink,
  lstat as nodeLstat,
  realpath as nodeRealpath,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { WalletLogoInvalid, WalletLogoStorageUnavailable } from './wallet-core.errors.js';
import type { WalletLogoUrlResolver } from './wallet-core.types.js';

const KEY = /^[0-9a-f]{64}\.webp$/;
type RootIdentity = Readonly<{ dev: bigint; ino: bigint; supported: boolean }>;

export interface WalletLogoStorage extends WalletLogoUrlResolver {
  putWebp(objectKey: string, bytes: Buffer): Promise<void>;
  delete(objectKey: string): Promise<void>;
}

export interface LocalWalletLogoStorageOptions {
  readonly root: string;
  readonly publicBaseUrl: string;
  readonly fileSystem?: LocalWalletLogoFileSystem;
}

export interface LocalWalletLogoFileSystem {
  lstat(path: string): Promise<Readonly<{
    dev: bigint;
    ino: bigint;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>>;
  realpath(path: string): Promise<string>;
  writeFile(
    path: string,
    bytes: Uint8Array,
    options: Readonly<{ flag: 'wx'; mode: number }>,
  ): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: LocalWalletLogoFileSystem = {
  lstat: (path) => nodeLstat(path, { bigint: true }),
  realpath: nodeRealpath,
  writeFile: (path, bytes, options) => nodeWriteFile(path, bytes, options),
  link: nodeLink,
  unlink: nodeUnlink,
};

export function createWalletLogoObjectKey(): string {
  return `${randomBytes(32).toString('hex')}.webp`;
}

function validBase(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new WalletLogoInvalid('Wallet logo public base URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new WalletLogoInvalid('Wallet logo public base URL is invalid.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function validateKey(objectKey: string): void {
  if (!KEY.test(objectKey)) throw new WalletLogoInvalid('Wallet logo object key is invalid.');
}

/**
 * Local development/test adapter. Its parent directory must be writable only by the trusted
 * process account. Deployment replaces it through WalletLogoStorage without changing records.
 */
export class LocalWalletLogoStorage implements WalletLogoStorage {
  private constructor(
    private readonly configuredRoot: string,
    private readonly root: string,
    private readonly identity: RootIdentity,
    private readonly base: URL,
    private readonly fileSystem: LocalWalletLogoFileSystem,
  ) {}

  static async create(options: LocalWalletLogoStorageOptions): Promise<LocalWalletLogoStorage> {
    if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
      throw new WalletLogoInvalid(
        'Local wallet logo storage is available only in development and test.',
      );
    }
    try {
      if (!isAbsolute(options.root)) throw new Error('root must be absolute');
      const fileSystem = options.fileSystem ?? nodeFileSystem;
      const configuredRoot = resolve(options.root);
      const status = await fileSystem.lstat(configuredRoot);
      if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('root is not owned');
      const identity = { dev: status.dev, ino: status.ino,
        supported: status.dev !== 0n || status.ino !== 0n };
      return new LocalWalletLogoStorage(configuredRoot, await fileSystem.realpath(configuredRoot),
        identity, validBase(options.publicBaseUrl), fileSystem);
    } catch (error) {
      if (error instanceof WalletLogoInvalid) throw error;
      throw new WalletLogoInvalid('Wallet logo storage root is invalid.');
    }
  }

  async putWebp(objectKey: string, bytes: Buffer): Promise<void> {
    validateKey(objectKey);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new WalletLogoInvalid('Wallet logo WebP bytes are required.');
    }
    await this.assertRoot();
    const finalPath = this.path(objectKey);
    const temporaryPath = this.path(`.${randomBytes(32).toString('hex')}.tmp`);
    let finalized = false;
    try {
      await this.fileSystem.writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
      await this.assertRoot();
      // A hard link publishes atomically without ever exposing a partially written image.
      await this.fileSystem.link(temporaryPath, finalPath);
      finalized = true;
      await this.assertRoot();
      await this.fileSystem.unlink(temporaryPath);
      await this.assertRoot();
    } catch {
      await this.fileSystem.unlink(temporaryPath).catch(() => undefined);
      if (finalized) await this.fileSystem.unlink(finalPath).catch(() => undefined);
      throw new WalletLogoStorageUnavailable();
    }
  }

  async delete(objectKey: string): Promise<void> {
    validateKey(objectKey);
    await this.assertRoot();
    let failed = false;
    try { await this.fileSystem.unlink(this.path(objectKey)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed = true;
      }
    }
    await this.assertRoot();
    if (failed) throw new WalletLogoStorageUnavailable();
  }

  publicUrl(objectKey: string): string {
    validateKey(objectKey);
    return new URL(encodeURIComponent(objectKey), this.base).toString();
  }

  private path(name: string): string {
    const target = resolve(this.root, name);
    if (dirname(target) !== this.root) throw new WalletLogoInvalid('Wallet logo path is invalid.');
    return target;
  }

  private async assertRoot(): Promise<void> {
    // Revalidate path and inode around mutations to detect symlink or directory replacement.
    try {
      const status = await this.fileSystem.lstat(this.configuredRoot);
      const current = await this.fileSystem.realpath(this.configuredRoot);
      if (!status.isDirectory() || status.isSymbolicLink() || current !== this.root) {
        throw new Error('root changed');
      }
      if (this.identity.supported
        && (status.dev !== this.identity.dev || status.ino !== this.identity.ino)) {
        throw new Error('root identity changed');
      }
    } catch {
      throw new WalletLogoStorageUnavailable();
    }
  }
}
