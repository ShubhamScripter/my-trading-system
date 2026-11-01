import { randomBytes } from 'node:crypto';

const MAX_PREFIX_LENGTH = 103;

/** Adds a fresh database-owner suffix while retaining the configured diagnostic host identity. */
export function walletWorkerInvocationId(value: string): string {
  const prefix = typeof value === 'string' ? value.trim() : '';
  if (prefix.length === 0 || prefix.length > MAX_PREFIX_LENGTH
    || /[\u0000-\u001f\u007f]/.test(prefix)) {
    throw new Error('WALLET_WORKER_INSTANCE_ID_INVALID');
  }
  return `${prefix}:${randomBytes(12).toString('hex')}`;
}
