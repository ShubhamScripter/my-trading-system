import assert from 'node:assert/strict';
import test from 'node:test';

import { WALLET_CORE_ADMIN_AUDIT_ACTIONS, type WalletCoreAdminAuditInput } from './admin-audit.types.js';
import { buildWalletCoreAdminAuditEvent } from './admin-audit.payloads.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const KEY = `${'a'.repeat(64)}.webp`;
const ADMIN = {
  kind: 'ADMIN', actorId: UUID, sessionId: UUID, requestId: UUID,
  ipAddress: '127.0.0.1', deviceId: 'device',
} as const;
const input = (overrides: Record<string, unknown> = {}) => ({
  domain: 'WALLET_CORE', action: 'LOGO.UPLOADED', eventKey: `wallet-logo:${KEY}`,
  actor: ADMIN, subject: { type: 'LOGO_ASSET', id: KEY }, reason: 'wallet-logo-upload',
  before: { stored: false },
  after: { stored: true, mediaType: 'image/webp', width: 500, height: 500, bytes: 1_048_576 },
  metadata: { sourceFormat: 'PNG' }, ...overrides,
});

type LogoInput = Extract<WalletCoreAdminAuditInput, { readonly action: 'LOGO.UPLOADED' }>;
const logoAfter: NonNullable<LogoInput['after']> = {
  stored: true, mediaType: 'image/webp', width: 500, height: 500, bytes: 1,
};
// @ts-expect-error normalized output media type is closed
const illegalMediaType: NonNullable<LogoInput['after']>['mediaType'] = 'image/png';
// @ts-expect-error source format is closed to decoded raster inputs
const illegalSourceFormat: LogoInput['metadata']['sourceFormat'] = 'GIF';
void logoAfter;
void illegalMediaType;
void illegalSourceFormat;

test('builds the exact safe normalized logo-upload fact for every source format', () => {
  assert.equal(WALLET_CORE_ADMIN_AUDIT_ACTIONS.includes('LOGO.UPLOADED' as never), true);
  for (const sourceFormat of ['PNG', 'JPEG', 'WEBP', 'AVIF']) {
    const event = buildWalletCoreAdminAuditEvent(input({
      subject: { type: 'LOGO_ASSET', id: `\t${KEY}\n` },
      reason: ' wallet-logo-upload ', metadata: { sourceFormat },
    }) as never);
    assert.deepEqual({ subject: event.subject, reason: event.reason, before: event.before,
      after: event.after, metadata: event.metadata }, {
      subject: { type: 'LOGO_ASSET', id: KEY }, reason: 'wallet-logo-upload',
      before: { stored: false },
      after: { stored: true, mediaType: 'image/webp', width: 500, height: 500, bytes: 1_048_576 },
      metadata: { sourceFormat },
    });
  }
});

test('rejects unsafe logo identities, facts, bounds, actors, and payload fields', () => {
  for (const candidate of [
    input({ actor: { kind: 'SYSTEM', runId: UUID } }),
    input({ subject: { type: 'LOGO_ASSET', id: KEY.toUpperCase() } }),
    input({ subject: { type: 'LOGO_ASSET', id: '../logo.webp' } }),
    input({ subject: { type: 'LOGO_ASSET', id: `https://assets.invalid/${KEY}` } }),
    input({ reason: 'logo-upload' }), input({ before: null }), input({ before: { stored: true } }),
    input({ after: null }), input({ after: { stored: true, mediaType: 'image/webp', width: 500, height: 500 } }),
    input({ after: { stored: false, mediaType: 'image/webp', width: 500, height: 500, bytes: 1 } }),
    input({ after: { stored: true, mediaType: 'image/png', width: 500, height: 500, bytes: 1 } }),
    input({ after: { stored: true, mediaType: 'image/webp', width: 0, height: 0, bytes: 1 } }),
    input({ after: { stored: true, mediaType: 'image/webp', width: 501, height: 501, bytes: 1 } }),
    input({ after: { stored: true, mediaType: 'image/webp', width: 499, height: 500, bytes: 1 } }),
    input({ after: { stored: true, mediaType: 'image/webp', width: 500, height: 500, bytes: 0 } }),
    input({ after: { stored: true, mediaType: 'image/webp', width: 500, height: 500, bytes: 1_048_577 } }),
    input({ metadata: { sourceFormat: 'GIF' } }), input({ metadata: { sourceFormat: 'PNG', sha256: 'secret' } }),
    input({ after: { stored: true, mediaType: 'image/webp', width: 500, height: 500, bytes: 1, rawImage: 'x' } }),
    input({ rawImage: 'x' }), input({ path: 'x' }), input({ url: 'https://assets.invalid/logo.webp' }),
  ]) assert.throws(() => buildWalletCoreAdminAuditEvent(candidate as never), /ADMIN_AUDIT_INPUT_INVALID/);
});
