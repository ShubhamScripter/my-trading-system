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
    // Creates and migrates the integration-test database once per run, and reports
    // through `provide` whether it is usable. Specs that need it read that with
    // `inject('pgAvailable')` and skip themselves when it is false, so a machine
    // with no Postgres still gets a green `npm test`. See tests/db/global-setup.ts.
    globalSetup: ['./tests/db/global-setup.ts'],
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'tests/'],
    },
  },
});
