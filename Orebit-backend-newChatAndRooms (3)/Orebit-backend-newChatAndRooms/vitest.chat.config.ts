import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Chat specs. The default vitest.config.ts excludes tests/social (owner's file, FR-006), so the chat team runs them
 * with this config:
 *
 *   npx vitest run --config vitest.chat.config.ts tests/social
 *
 * The DB-backed specs need a migrated scratch database in CHAT_TEST_DATABASE_URL (never orebit_dev); without it they
 * skip. For `prisma migrate deploy` on a scratch DB set BOTH DATABASE_URL and DATABASE_DIRECT_URL.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/social/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
