import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { FILTER_CATCH_EXCEPTIONS } from '@nestjs/common/constants.js';
import ts from 'typescript';
import {
  WalletConfigurationConflict,
  WalletConfigurationInvalid,
  WalletDomainError,
  WalletLogoInvalid,
  WalletLogoStorageUnavailable,
  WalletLogoTooLarge,
  WalletPreferenceInvalid,
  WalletProviderUnavailable,
  WalletAuthorizationUnavailable,
} from '../wallet-core.errors.js';
import { WalletCoreExceptionFilter } from '../wallet-core.filter.js';

interface CapturedReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function capture(error: WalletDomainError): CapturedReply {
  let status = 0;
  const headers: Record<string, string> = {};
  let body: unknown;
  const reply = {
    status(value: number) { status = value; return this; },
    header(name: string, value: string) { headers[name] = value; return this; },
    send(value: unknown) { body = value; },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({
        id: '01920000-0000-7000-8000-000000000012',
        url: '/v1/admin/wallet/core',
      }),
    }),
  } as never;

  new WalletCoreExceptionFilter().catch(error, host);
  return { status, headers, body };
}

describe('Wallet Core domain problem mapping', () => {
  it('resolves the filter Fastify types from the canonical Admin root package', () => {
    const testDirectory = __dirname;
    const filterPath = resolve(testDirectory, '..', 'wallet-core.filter.ts');
    const source = ts.createSourceFile(
      filterPath,
      ts.sys.readFile(filterPath) ?? '',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const fastifyImport = source.statements.find(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.includes('fastify'),
    );
    assert.ok(fastifyImport && ts.isStringLiteral(fastifyImport.moduleSpecifier));
    const resolution = ts.resolveModuleName(
      fastifyImport.moduleSpecifier.text,
      filterPath,
      { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 },
      ts.sys,
    ).resolvedModule;

    assert.ok(resolution);
    const canonicalRoot = resolve(testDirectory, '..', '..', '..', '..', 'node_modules', 'fastify')
      .replaceAll('\\', '/')
      .toLowerCase();
    assert.equal(
      resolution.resolvedFileName.replaceAll('\\', '/').toLowerCase().startsWith(canonicalRoot),
      true,
    );
  });

  it('maps every closed Wallet error to its stable RFC 9457 status and title', () => {
    const cases = [
      [new WalletConfigurationConflict(17), 'wallet_configuration_conflict', 409, 'Wallet configuration revision conflict'],
      [new WalletConfigurationInvalid(), 'wallet_configuration_invalid', 400, 'Invalid Wallet configuration'],
      [new WalletPreferenceInvalid(), 'wallet_preference_invalid', 400, 'Invalid Wallet preference'],
      [new WalletProviderUnavailable(), 'wallet_provider_unavailable', 503, 'Wallet provider unavailable'],
      [new WalletLogoInvalid(), 'wallet_logo_invalid', 400, 'Invalid Wallet logo'],
      [new WalletLogoTooLarge(), 'wallet_logo_too_large', 413, 'Wallet logo too large'],
      [new WalletLogoStorageUnavailable(), 'wallet_logo_storage_unavailable', 503,
        'Wallet logo storage unavailable'],
      [new WalletAuthorizationUnavailable(), 'wallet_authorization_unavailable', 403,
        'Wallet authorization unavailable'],
    ] as const;

    for (const [error, type, expectedStatus, title] of cases) {
      const response = capture(error);
      assert.equal(response.status, expectedStatus);
      assert.equal(response.headers['content-type'], 'application/problem+json');
      assert.deepEqual(response.body, {
        type,
        title,
        status: expectedStatus,
        instance: '/v1/admin/wallet/core',
        requestId: '01920000-0000-7000-8000-000000000012',
        ...(error instanceof WalletConfigurationConflict
          ? { extra: { actualRevision: 17 } }
          : {}),
      });
    }
  });

  it('exposes only explicitly supplied validation detail', () => {
    const cases = [
      [new WalletConfigurationInvalid('Currency state is not valid.'), 'wallet_configuration_invalid', 'Invalid Wallet configuration'],
      [new WalletPreferenceInvalid('View currency is unavailable.'), 'wallet_preference_invalid', 'Invalid Wallet preference'],
      [new WalletLogoInvalid('Logo must use a supported raster format.'), 'wallet_logo_invalid', 'Invalid Wallet logo'],
      [new WalletLogoTooLarge('Logo must not exceed 1 MiB.'), 'wallet_logo_too_large', 'Wallet logo too large'],
    ] as const;

    for (const [error, type, title] of cases) {
      const response = capture(error);
      assert.deepEqual(response.body, {
        type,
        title,
        status: error.status,
        detail: error.detail,
        instance: '/v1/admin/wallet/core',
        requestId: '01920000-0000-7000-8000-000000000012',
      });
    }
  });

  it('returns only actualRevision for conflicts and never leaks internal fields', () => {
    const error = new WalletConfigurationConflict(23) as WalletConfigurationConflict & Record<string, unknown>;
    error.sql = 'SELECT secret FROM wallet_core.settings';
    error.sqlstate = '23505';
    error.cause = new Error('driver connection failed');
    error.providerPayload = { token: 'secret' };

    const response = capture(error);
    assert.deepEqual(response.body, {
      type: 'wallet_configuration_conflict',
      title: 'Wallet configuration revision conflict',
      status: 409,
      instance: '/v1/admin/wallet/core',
      requestId: '01920000-0000-7000-8000-000000000012',
      extra: { actualRevision: 23 },
    });
    const serialized = JSON.stringify(response.body).toLowerCase();
    for (const forbidden of ['select ', '23505', 'stack', 'cause', 'driver', 'providerpayload', 'secret']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });

  it('catches only Wallet domain errors and rethrows unknown failures unchanged', () => {
    assert.deepEqual(
      Reflect.getMetadata(FILTER_CATCH_EXCEPTIONS, WalletCoreExceptionFilter),
      [WalletDomainError],
    );
    const unknown = new Error('database driver detail');
    const filter = new WalletCoreExceptionFilter();

    assert.throws(
      () => filter.catch(unknown as never, {} as never),
      (caught: unknown) => caught === unknown,
    );
  });
});
