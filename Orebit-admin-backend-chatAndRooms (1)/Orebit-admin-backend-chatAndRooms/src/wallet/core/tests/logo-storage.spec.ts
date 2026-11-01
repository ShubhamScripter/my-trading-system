import assert from 'node:assert/strict';
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type SharpModule = require('../node_modules/sharp/lib/index');
import { WalletLogoInvalid, WalletLogoStorageUnavailable } from '../wallet-core.errors.js';
import { normalizeWalletLogo } from '../logo-processing.js';
import {
  LocalWalletLogoStorage,
  createWalletLogoObjectKey,
  type WalletLogoStorage,
} from '../logo-storage.js';

const sharp = createRequire(__filename)('sharp') as typeof SharpModule;

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orebit-wallet-logo-'));
  roots.push(root);
  return root;
}

async function inNodeEnvironment<T>(
  value: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try { return await work(); }
  finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

const nodeFileSystem = {
  lstat: (path: string) => lstat(path, { bigint: true }),
  realpath,
  writeFile: (path: string, bytes: Uint8Array, options: { flag: 'wx'; mode: number }) =>
    writeFile(path, bytes, options),
  link,
  unlink,
};
type TestFileSystem = typeof nodeFileSystem;
const storageUnavailable = (error: unknown): boolean => {
  assert.ok(error instanceof WalletLogoStorageUnavailable);
  assert.equal(error.status, 503);
  assert.equal('detail' in error, false);
  return true;
};

const createStorage = (
  options: Parameters<typeof LocalWalletLogoStorage.create>[0],
  fileSystem: TestFileSystem = nodeFileSystem,
) => inNodeEnvironment('test', () => LocalWalletLogoStorage.create({
  ...options, fileSystem,
}));
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function webp(): Promise<Buffer> {
  return (await normalizeWalletLogo(await sharp({
    create: { width: 500, height: 500, channels: 3, background: 'navy' },
  }).png().toBuffer())).content;
}

describe('replaceable local Wallet logo storage', () => {
  it('writes exclusively, never overwrites, cleans temporary files, and deletes idempotently', async () => {
    const root = await temporaryRoot();
    const storage: WalletLogoStorage = await createStorage({
      root, publicBaseUrl: 'https://assets.test.invalid/wallet%20assets/',
    });
    const key = createWalletLogoObjectKey();
    const bytes = await webp();

    await storage.putWebp(key, bytes);
    assert.deepEqual(await readFile(join(root, key)), bytes);
    assert.equal(storage.publicUrl(key), `https://assets.test.invalid/wallet%20assets/${key}`);
    assert.deepEqual(await readdir(root), [key]);

    await assert.rejects(() => storage.putWebp(key, Buffer.from('replacement')),
      storageUnavailable);
    assert.deepEqual(await readFile(join(root, key)), bytes);
    assert.deepEqual(await readdir(root), [key]);
    await storage.delete(key);
    await storage.delete(key);
    assert.deepEqual(await readdir(root), []);
  });

  it('generates unique flat opaque WebP keys and rejects path traversal', async () => {
    const root = await temporaryRoot();
    const storage = await createStorage({
      root, publicBaseUrl: 'https://assets.test.invalid/wallet/',
    });
    const keys = new Set(Array.from({ length: 100 }, () => createWalletLogoObjectKey()));
    assert.equal(keys.size, 100);
    for (const key of keys) assert.match(key, /^[0-9a-f]{64}\.webp$/);
    for (const key of ['../escape.webp', 'nested/logo.webp', 'logo.png', '', 'a'.repeat(300)]) {
      await assert.rejects(() => storage.putWebp(key, Buffer.from('x')), WalletLogoInvalid);
      assert.throws(() => storage.publicUrl(key), WalletLogoInvalid);
    }
    assert.equal(await readFile(resolve(root, '..', 'escape.webp')).catch(() => null), null);
  });

  it('rejects invalid public bases and non-owned roots', async () => {
    const root = await temporaryRoot();
    for (const publicBaseUrl of [
      'http://assets.test.invalid/wallet/',
      'https://user:pass@assets.test.invalid/wallet/',
      'https://assets.test.invalid/wallet/?token=x',
      'https://assets.test.invalid/wallet/#fragment',
      'not a URL',
    ]) await assert.rejects(
      () => createStorage({ root, publicBaseUrl }),
      WalletLogoInvalid,
    );
    await assert.rejects(() => createStorage({
      root: 'relative/path', publicBaseUrl: 'https://assets.test.invalid/wallet/',
    }), WalletLogoInvalid);
    const file = join(root, 'file');
    await writeFile(file, 'not a directory');
    await assert.rejects(() => createStorage({
      root: file, publicBaseUrl: 'https://assets.test.invalid/wallet/',
    }), WalletLogoInvalid);
  });

  it('rejects a symlink/junction root and detects ordinary root replacement before writing', async () => {
    const parent = await temporaryRoot();
    const root = join(parent, 'owned');
    const outside = join(parent, 'outside');
    await mkdir(root); await mkdir(outside);
    const link = join(parent, 'linked');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => createStorage({
      root: link, publicBaseUrl: 'https://assets.test.invalid/wallet/',
    }), WalletLogoInvalid);

    const storage = await createStorage({
      root, publicBaseUrl: 'https://assets.test.invalid/wallet/',
    });
    const moved = join(parent, 'moved');
    await rename(root, moved);
    await mkdir(root);
    const bytes = await webp();
    await assert.rejects(() => storage.putWebp(createWalletLogoObjectKey(), bytes),
      storageUnavailable);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(await readdir(moved), []);
  });

  it('fails closed outside development and test', async () => {
    const root = await temporaryRoot();
    const options = { root, publicBaseUrl: 'https://assets.test.invalid/wallet/' };
    for (const environment of [undefined, 'production', 'staging']) {
      await inNodeEnvironment(environment, () => assert.rejects(
        () => LocalWalletLogoStorage.create(options), WalletLogoInvalid,
      ));
    }
    for (const environment of ['development', 'test']) {
      await inNodeEnvironment(environment, async () => {
        assert.ok(await LocalWalletLogoStorage.create(options));
      });
    }
  });

  it('rechecks the root after a check-to-write replacement and removes its temporary file', async () => {
    const parent = await temporaryRoot();
    const root = join(parent, 'owned');
    const moved = join(parent, 'moved');
    await mkdir(root);
    let swapped = false;
    const fileSystem: TestFileSystem = {
      ...nodeFileSystem,
      async writeFile(path, bytes, options) {
        if (!swapped) {
          swapped = true;
          await rename(root, moved);
          await mkdir(root);
        }
        await nodeFileSystem.writeFile(path, bytes, options);
      },
    };
    const storage = await createStorage({
      root, publicBaseUrl: 'https://assets.test.invalid/wallet/',
    }, fileSystem);

    await assert.rejects(() => storage.putWebp(createWalletLogoObjectKey(), Buffer.from('webp')),
      storageUnavailable);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(await readdir(moved), []);
  });

  it('allows only one concurrent writer for the same object key without leftovers', async () => {
    const root = await temporaryRoot();
    const storage = await createStorage({
      root, publicBaseUrl: 'https://assets.test.invalid/wallet/',
    });
    const key = createWalletLogoObjectKey();
    const outcomes = await Promise.allSettled([
      storage.putWebp(key, Buffer.from('first')),
      storage.putWebp(key, Buffer.from('second')),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    assert.deepEqual(await readdir(root), [key]);
    assert.ok(['first', 'second'].includes((await readFile(join(root, key))).toString()));
  });

  it('removes artifacts after write, link, and post-link temporary-unlink failures', async () => {
    for (const position of ['write', 'link', 'temp-unlink'] as const) {
      const root = await temporaryRoot();
      let injected = false;
      const fileSystem: TestFileSystem = {
        ...nodeFileSystem,
        async writeFile(path, bytes, options) {
          if (position === 'write' && !injected) {
            injected = true;
            await nodeFileSystem.writeFile(path, Buffer.from('partial'), options);
            throw new Error('WRITE_FAIL');
          }
          await nodeFileSystem.writeFile(path, bytes, options);
        },
        async link(existingPath, newPath) {
          if (position === 'link' && !injected) {
            injected = true;
            throw new Error('LINK_FAIL');
          }
          await nodeFileSystem.link(existingPath, newPath);
        },
        async unlink(path) {
          if (position === 'temp-unlink' && String(path).endsWith('.tmp') && !injected) {
            injected = true;
            throw new Error('UNLINK_FAIL');
          }
          await nodeFileSystem.unlink(path);
        },
      };
      const storage = await createStorage({
        root, publicBaseUrl: 'https://assets.test.invalid/wallet/',
      }, fileSystem);
      await assert.rejects(() => storage.putWebp(createWalletLogoObjectKey(), Buffer.from('webp')),
        storageUnavailable, position);
      assert.deepEqual(await readdir(root), [], position);
    }
  });

  it('reports delete failure without removing the stored object', async () => {
    const root = await temporaryRoot();
    let failDelete = false;
    const fileSystem: TestFileSystem = {
      ...nodeFileSystem,
      async unlink(path) {
        if (failDelete && String(path).endsWith('.webp')) {
          failDelete = false;
          const error = new Error('DELETE_FAIL') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await nodeFileSystem.unlink(path);
      },
    };
    const storage = await createStorage({
      root, publicBaseUrl: 'https://assets.test.invalid/wallet/',
    }, fileSystem);
    const key = createWalletLogoObjectKey();
    await storage.putWebp(key, Buffer.from('webp'));
    failDelete = true;

    await assert.rejects(() => storage.delete(key), storageUnavailable);
    assert.equal((await readFile(join(root, key))).toString(), 'webp');
    await storage.delete(key);
    assert.deepEqual(await readdir(root), []);
  });
});
