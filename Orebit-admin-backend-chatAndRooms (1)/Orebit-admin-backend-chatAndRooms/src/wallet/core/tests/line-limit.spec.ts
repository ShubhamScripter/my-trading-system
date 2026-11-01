import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { it } from 'node:test';

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'generated', 'migrations', '.test-dist', '.review-baseline',
]);
const AUTHORED_EXTENSIONS = new Set(['.ts', '.cts', '.mjs', '.cjs']);

async function authoredFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...await authoredFiles(resolve(directory, entry.name)));
      }
    } else if (entry.isFile() && AUTHORED_EXTENSIONS.has(extname(entry.name))) {
      files.push(resolve(directory, entry.name));
    }
  }
  return files;
}

it('keeps authored Wallet Core TypeScript and CommonJS files below 500 lines', async () => {
  const root = resolve(__dirname, '..');
  const violations: string[] = [];
  for (const file of await authoredFiles(root)) {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/).length;
    if (lines > 500) violations.push(`${relative(root, file)} has ${lines} lines`);
  }
  assert.deepEqual(violations, []);
});
