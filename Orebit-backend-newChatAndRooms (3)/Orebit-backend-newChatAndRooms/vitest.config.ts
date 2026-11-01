import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // esbuild — vitest's default transform — does not implement
  // `emitDecoratorMetadata`, and Nest's DI reads constructor parameter types
  // from exactly that metadata. Without SWC here, any spec that builds a
  // testing module fails to resolve its providers.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],

    // Placeholder specs for modules that do not exist yet. They are empty files, and
    // vitest reports `No test suite found in file` for each one — which is a failure,
    // so `npm test` exits non-zero however green the real suites are. Excluded rather
    // than deleted: the paths are the agreed layout for those modules, and the day one
    // gets its first test is the day its line comes off this list.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // `tests/db/**` came off this list when `migrations.spec.ts` and
      // `constraints.spec.ts` got their first content — they read the DDL rather than
      // running it, so they need no database and no Docker.
      'tests/earning/**',
      'tests/ledger/**',
      'tests/merchant/**',
      'tests/social/**',
      'tests/wallet/**',
    ],

    // The live-Redis quota suite sleeps 1.1s to prove the sliding window actually
    // slides. The 5s default leaves no room for a slow CI container on top of that.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'tests/'],
    },
  },
});
