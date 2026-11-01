import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import type { Principal } from '../../../../auth/auth.types.js';
import { SuperAdminOnlyWalletAuthorization } from '../wallet-core.authorization.js';
import {
  WALLET_ADMIN_PERMISSIONS,
  type WalletAdminAuthorizationPort,
  type WalletAdminPermission,
} from '../wallet-core.types.js';

const PRINCIPAL = {
  adminId: '01920000-0000-7000-8000-000000000010',
  sessionId: '01920000-0000-7000-8000-000000000011',
  role: 'SUPER_ADMIN',
} satisfies Principal;

const ADMIN_ROOT = resolve(__dirname, '..', '..', '..', '..');
const WALLET_ROOT = resolve(__dirname, '..');

function assertCanonicalPrincipalBoundary(_source: string, _fileName: string): void {
  const forbiddenNames = new Set([
    'Principal', 'AdminPrincipal', 'AdminRole', 'AdminLoginState', 'AdminMfaMethod',
  ]);
  const parsed = ts.createSourceFile(
    _fileName,
    _source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const authImports = parsed.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === '../../../auth/auth.types.js',
  );
  const canonicalImport = authImports[0];
  const bindings = canonicalImport?.importClause?.namedBindings;
  const principalImports = bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
  const importedPrincipal = principalImports[0];
  if (
    authImports.length !== 1 ||
    canonicalImport?.importClause?.isTypeOnly !== true ||
    principalImports.length !== 1 ||
    importedPrincipal?.name.text !== 'Principal' ||
    importedPrincipal.propertyName !== undefined
  ) {
    throw new Error(`${_fileName}: canonical type-only Principal import is required`);
  }

  const visit = (node: ts.Node): void => {
    const named = node as ts.NamedDeclaration;
    const name = named.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
    if (name && forbiddenNames.has(name) && node !== importedPrincipal) {
      throw new Error(`${_fileName}: forbidden local Auth declaration ${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);

  const target = basename(_fileName).toLowerCase();
  let requireDeclaration: ts.MethodSignature | ts.MethodDeclaration | undefined;
  if (target === 'wallet-core.types.ts') {
    const port = parsed.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'WalletAdminAuthorizationPort',
    );
    requireDeclaration = port?.members.find(
      (member): member is ts.MethodSignature =>
        ts.isMethodSignature(member) && ts.isIdentifier(member.name) && member.name.text === 'require',
    );
  } else if (target === 'wallet-core.authorization.ts') {
    const adapter = parsed.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) &&
        statement.name?.text === 'SuperAdminOnlyWalletAuthorization',
    );
    requireDeclaration = adapter?.members.find(
      (member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === 'require',
    );
  }
  if (target === 'wallet-core.types.ts' || target === 'wallet-core.authorization.ts') {
    const parameters = requireDeclaration?.parameters;
    const firstType = parameters?.[0]?.type;
    if (!firstType || !ts.isTypeReferenceNode(firstType) ||
      !ts.isIdentifier(firstType.typeName) || firstType.typeName.text !== 'Principal') {
      throw new Error(`${_fileName}: first require parameter must use canonical Principal`);
    }
    const secondType = parameters?.[1]?.type;
    if (parameters?.length !== 2 || !secondType || !ts.isTypeReferenceNode(secondType) ||
      !ts.isIdentifier(secondType.typeName) || secondType.typeName.text !== 'WalletAdminPermission') {
      throw new Error(`${_fileName}: second require parameter must use WalletAdminPermission`);
    }
    const returnType = requireDeclaration?.type;
    if (!returnType || !ts.isTypeReferenceNode(returnType) ||
      !ts.isIdentifier(returnType.typeName) || returnType.typeName.text !== 'Promise' ||
      returnType.typeArguments?.length !== 1 ||
      returnType.typeArguments[0]?.kind !== ts.SyntaxKind.VoidKeyword) {
      throw new Error(`${_fileName}: require return type must be Promise<void>`);
    }
  }
}

function decoratorName(decorator: ts.Decorator): string | undefined {
  const expression = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
}

function assertNoForbiddenWalletSource(source: string, fileName: string): void {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const forbiddenRootProblems = new Set(['ProblemException', 'ERR']);
  const forbiddenDecorators = new Set([
    'Controller', 'Module', 'Get', 'Post', 'Put', 'Patch', 'Delete',
    'Head', 'Options', 'All', 'Sse', 'Public',
  ]);
  const forbiddenDecoratorBindings = new Set(forbiddenDecorators);
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const binding of statement.importClause.namedBindings.elements) {
        if (forbiddenDecorators.has(binding.propertyName?.text ?? binding.name.text)) {
          forbiddenDecoratorBindings.add(binding.name.text);
        }
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && forbiddenRootProblems.has(node.text)) {
      throw new Error(`${fileName}: forbidden root problem import ${node.text}`);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) &&
      forbiddenRootProblems.has(node.argumentExpression.text)) {
      throw new Error(`${fileName}: forbidden root problem import ${node.argumentExpression.text}`);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      /(?:^|[/\\])(http|contracts)(?:\.[^/\\]+)?$/i.test(node.moduleSpecifier.text) &&
      (node.importClause?.name || node.importClause?.namedBindings &&
        ts.isNamespaceImport(node.importClause.namedBindings))) {
      throw new Error(`${fileName}: forbidden root problem import namespace/default`);
    }
    for (const decorator of ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []) {
      const name = decoratorName(decorator);
      if (name && forbiddenDecoratorBindings.has(name)) {
        throw new Error(`${fileName}: forbidden Wallet transport decorator ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}

function assertNoForbiddenWalletFileName(fileName: string): void {
  if (/^(?:.+\.)?(controller|module|routes)\.ts$/i.test(basename(fileName))) {
    throw new Error(`${fileName}: forbidden Wallet transport file`);
  }
}

function isWalletCoreSpecifier(value: ts.Expression | undefined): boolean {
  return Boolean(
    value && ts.isStringLiteralLike(value) &&
    /(?:^|[/\\])wallet[/\\]core(?:[/\\]|$)/i.test(value.text),
  );
}

function assertRootCompositionUnmounted(source: string, fileName: string): void {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    const staticModule = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
      ? node.moduleSpecifier
      : undefined;
    const callModule = ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ? node.arguments[0]
      : undefined;
    const importEqualsModule = ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
      ? node.moduleReference.expression
      : undefined;
    if (isWalletCoreSpecifier(staticModule) || isWalletCoreSpecifier(callModule) ||
      isWalletCoreSpecifier(importEqualsModule)) {
      throw new Error(`${fileName}: Wallet Core must remain unmounted`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}

function assertNoTaskThreeTransportSurface(): void {
  for (const name of [
    'wallet-core.types.ts', 'wallet-core.admin-view.types.ts', 'wallet-core.authorization.ts',
    'wallet-core.dto.ts', 'wallet-core.errors.ts', 'wallet-core.filter.ts',
    'wallet-core.policy.ts', 'wallet-core.cursor.ts',
  ]) {
    const path = resolve(WALLET_ROOT, name);
    assertNoForbiddenWalletFileName(path);
    assertNoForbiddenWalletSource(readFileSync(path, 'utf8'), path);
  }
  for (const path of ['src/app.module.ts', 'src/main.ts']) {
    assertRootCompositionUnmounted(
      readFileSync(resolve(ADMIN_ROOT, path), 'utf8'),
      basename(path),
    );
  }
}

describe('Wallet-owned Deposit authorization contract', () => {
  it('exports the exact seven-member Wallet and Deposit permission tuple', () => {
    assert.deepEqual(WALLET_ADMIN_PERMISSIONS, [
      'WALLET_CORE_READ',
      'WALLET_CORE_CONFIGURE',
      'WALLET_CORE_IMPORT',
      'WALLET_CORE_RECONCILIATION_READ',
      'DEPOSIT_ADMIN_READ',
      'DEPOSIT_ADMIN_CONFIGURE',
      'DEPOSIT_ADMIN_MODERATE',
    ]);
  });

  it('accepts canonical Auth Principal first and Wallet permission second', async () => {
    const authorization: WalletAdminAuthorizationPort = new SuperAdminOnlyWalletAuthorization();
    const args: Parameters<WalletAdminAuthorizationPort['require']> = [
      PRINCIPAL,
      'DEPOSIT_ADMIN_MODERATE' satisfies WalletAdminPermission,
    ];

    assert.equal(authorization.require.length, 2);
    await assert.doesNotReject(() => authorization.require(...args));
  });

  it('rejects noncanonical Principal imports and local Auth aliases', () => {
    assert.throws(
      () => assertCanonicalPrincipalBoundary(
        "import { Principal } from '../../../auth/auth.types.js';",
        'value-import.ts',
      ),
      /canonical type-only Principal import/,
    );
    for (const name of ['Principal', 'AdminPrincipal', 'AdminRole', 'AdminLoginState', 'AdminMfaMethod']) {
      assert.throws(
        () => assertCanonicalPrincipalBoundary(
          `import type { Principal } from '../../../auth/auth.types.js'; type ${name} = string;`,
          `local-${name}.ts`,
        ),
        /forbidden local Auth declaration/,
      );
    }
  });

  it('uses only the canonical type-only Principal import in both producer files', () => {
    for (const fileName of ['wallet-core.types.ts', 'wallet-core.authorization.ts']) {
      assertCanonicalPrincipalBoundary(
        readFileSync(resolve(WALLET_ROOT, fileName), 'utf8'),
        fileName,
      );
    }
  });

  it('rejects authorization, transport, problem-import, and composition mutations', () => {
    const canonicalImport = "import type { Principal } from '../../../auth/auth.types.js';";
    const mutations: readonly {
      readonly name: string;
      readonly run: () => void;
      readonly expected: RegExp;
    }[] = [
      {
        name: 'interface require parameter type',
        run: () => assertCanonicalPrincipalBoundary(
          `${canonicalImport} interface WalletAdminAuthorizationPort { require(principal: unknown): Promise<void>; }`,
          'wallet-core.types.ts',
        ),
        expected: /first require parameter must use canonical Principal/,
      },
      {
        name: 'adapter require parameter type',
        run: () => assertCanonicalPrincipalBoundary(
          `${canonicalImport} class SuperAdminOnlyWalletAuthorization { require(principal: unknown): Promise<void> { return Promise.resolve(); } }`,
          'wallet-core.authorization.ts',
        ),
        expected: /first require parameter must use canonical Principal/,
      },
      {
        name: 'interface permission parameter type',
        run: () => assertCanonicalPrincipalBoundary(
          `${canonicalImport} interface WalletAdminAuthorizationPort { require(principal: Principal, permission: string): Promise<void>; }`,
          'wallet-core.types.ts',
        ),
        expected: /second require parameter must use WalletAdminPermission/,
      },
      {
        name: 'adapter return type',
        run: () => assertCanonicalPrincipalBoundary(
          `${canonicalImport} class SuperAdminOnlyWalletAuthorization { require(principal: Principal, permission: WalletAdminPermission): void {} }`,
          'wallet-core.authorization.ts',
        ),
        expected: /require return type must be Promise<void>/,
      },
      ...[
        'Controller', 'Module', 'Get', 'Post', 'Put', 'Patch', 'Delete',
        'Head', 'Options', 'All', 'Sse', 'Public',
      ].map((decorator) => ({
        name: `${decorator} local alias`,
        run: () => assertNoForbiddenWalletSource(
          `import { ${decorator} as Hidden } from '${decorator === 'Public' ? '../auth/security/guards.js' : '@nestjs/common'}'; @Hidden() class Unsafe {}`,
          'unsafe.ts',
        ),
        expected: /forbidden Wallet transport decorator/,
      })),
      ...[
        'controller.ts', 'MODULE.TS', 'routes.Ts',
        'Nested/Hidden.Controller.TS', 'hidden.MODULE.ts', 'deep/path/hidden.Routes.Ts',
      ].map(
        (fileName) => ({
          name: `${fileName} transport file`,
          run: () => assertNoForbiddenWalletFileName(fileName),
          expected: /forbidden Wallet transport file/,
        }),
      ),
      {
        name: 'default root problem import',
        run: () => assertNoForbiddenWalletSource("import Hidden from '../../http.js';", 'unsafe.ts'),
        expected: /forbidden root problem import/,
      },
      {
        name: 'namespace root problem member',
        run: () => assertNoForbiddenWalletSource(
          "import * as Hidden from '../../contracts.js'; const failure = Hidden.ERR;",
          'unsafe.ts',
        ),
        expected: /forbidden root problem import/,
      },
      ...[
        "import { ProblemException } from './barrel.mjs';",
        "import ProblemException from './anything';",
        "import * as Root from './barrel.cjs'; const failure = Root.ERR;",
        "import Root = require('./barrel'); const failure = Root.ProblemException;",
        "const { ERR: Hidden } = require('./barrel.coffee');",
        "const { ProblemException: Hidden } = await import('./barrel.json');",
        "export { ERR as Failure } from './barrel';",
      ].map((source, index) => ({
        name: `root problem syntax ${index + 1}`,
        run: () => assertNoForbiddenWalletSource(source, 'unsafe.ts'),
        expected: /forbidden root problem import/,
      })),
      ...[
        "import './wallet/core/wallet-core.module.js';",
        "export { WalletCoreModule } from './wallet/core/wallet-core.module.js';",
        "const module = import('./wallet/core/wallet-core.module.js');",
        "const module = require('./wallet/core/wallet-core.module.js');",
      ].map((source, index) => ({
        name: `composition load form ${index + 1}`,
        run: () => assertRootCompositionUnmounted(source, 'app.module.ts'),
        expected: /Wallet Core must remain unmounted/,
      })),
    ];

    for (const mutation of mutations) {
      assert.throws(mutation.run, mutation.expected, mutation.name);
    }
  });

  it('keeps Task 3 free of routes, writes, root problems, and composition imports', () => {
    for (const [source, expected] of [
      ["import { ProblemException } from '../../http.js';", /forbidden root problem import/],
      ["import { ProblemException as Hidden } from '../../http.js';", /forbidden root problem import/],
      ["import { ERR } from '../../contracts.js';", /forbidden root problem import/],
      ['@Public() class Unsafe {}', /forbidden Wallet transport decorator/],
      ['class Unsafe { @Post() write() {} }', /forbidden Wallet transport decorator/],
      ['class Unsafe { @Nest.Patch() write() {} }', /forbidden Wallet transport decorator/],
    ] as const) {
      assert.throws(() => assertNoForbiddenWalletSource(source, 'unsafe.ts'), expected);
    }
    assert.throws(
      () => assertRootCompositionUnmounted(
        "import { WalletCoreModule } from './wallet/core/wallet-core.module.js';",
        'app.module.ts',
      ),
      /Wallet Core must remain unmounted/,
    );
    assertNoTaskThreeTransportSurface();
  });
});
