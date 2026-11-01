import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WalletLogoCleanupWorker } from '../logo-cleanup-worker.js';

const LEASE = {
  id: '01990000-0000-7000-8000-000000000001',
  jobName: 'wallet-logo-cleanup',
  scheduledFor: '2026-09-08T00:00:00.000Z',
  workerInstanceId: 'logo-cleanup-regression',
  attemptCount: 1,
  leaseExpiresAt: '2026-09-08T00:05:00.000Z',
  startedAt: '2026-09-08T00:00:00.000Z',
} as const;

test('partial logo cleanup retains actual counts and a logo-specific safe reason', async () => {
  const completed: unknown[] = [];
  const deleted: string[] = [];
  const released: string[] = [];
  const renewed: string[] = [];
  const worker = new WalletLogoCleanupWorker({
    claimExpired: async () => ({ token: LEASE.id, objectKeys: ['first.webp', 'second.webp'] }),
    renewDeletion: async (key: string) => { renewed.push(key); },
    completeDeletion: async (key: string) => { deleted.push(key); },
    releaseDeletion: async (key: string) => { released.push(key); },
  } as never, {
    delete: async (key: string) => {
      if (key === 'second.webp') throw new Error('storage unavailable');
    },
  } as never, {
    claim: async () => LEASE,
    renew: async () => LEASE,
    complete: async (_lease: unknown, outcome: unknown) => { completed.push(outcome); },
  } as never);

  const result = await worker.runOnce({
    scheduledFor: new Date(LEASE.scheduledFor),
    workerInstanceId: LEASE.workerInstanceId,
  });

  assert.deepEqual(result, { processedCount: 1, failedCount: 1 });
  assert.deepEqual(deleted, ['first.webp']);
  assert.deepEqual(released, ['second.webp']);
  assert.deepEqual(renewed, ['first.webp', 'first.webp', 'second.webp']);
  assert.deepEqual(completed, [{
    status: 'PARTIAL', safeErrorCode: 'LOGO_CLEANUP_PARTIAL', skippedBucketCount: 0,
    processedCount: 1, failedCount: 1,
  }]);
});

test('logo cleanup bounds a stalled delete and leaves its claim fenced for retry', async () => {
  const completed: unknown[] = [];
  const released: string[] = [];
  const worker = new WalletLogoCleanupWorker({
    claimExpired: async () => ({ token: LEASE.id, objectKeys: ['stalled.webp'] }),
    renewDeletion: async () => undefined,
    completeDeletion: async () => { throw new Error('must not finalize a timed-out delete'); },
    releaseDeletion: async (key: string) => { released.push(key); },
  } as never, {
    delete: async () => new Promise<void>(() => undefined),
  } as never, {
    claim: async () => LEASE,
    renew: async () => LEASE,
    complete: async (_lease: unknown, outcome: unknown) => { completed.push(outcome); },
  } as never, 5);

  const result = await worker.runOnce({
    scheduledFor: new Date(LEASE.scheduledFor), workerInstanceId: LEASE.workerInstanceId,
  });

  assert.deepEqual(result, { processedCount: 0, failedCount: 1 });
  assert.deepEqual(released, []);
  assert.deepEqual(completed, [{ status: 'PARTIAL', safeErrorCode: 'LOGO_CLEANUP_PARTIAL',
    skippedBucketCount: 0, processedCount: 0, failedCount: 1 }]);
});
