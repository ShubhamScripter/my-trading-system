import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { describe, it } from 'node:test';

const CODE_EXTENSIONS = new Set(['.ts', '.cts', '.mjs']);
const GENERATED_DIRECTORIES = new Set(['.test-dist', 'generated', 'node_modules']);

describe('price-conversion authored file limits', () => {
  it('keeps every authored code and test file at 500 lines or fewer', async () => {
    const files = await authoredFiles(process.cwd());
    const oversized: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const lines = content === '' ? 0 : content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0);
      if (lines > 500) oversized.push(`${relative(process.cwd(), file)}:${lines}`);
    }

    assert.ok(files.some((file) => file.endsWith('price-conversion.service.ts')));
    assert.deepEqual(oversized, []);
  });
});

async function authoredFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!GENERATED_DIRECTORIES.has(entry.name)) result.push(...await authoredFiles(join(directory, entry.name)));
      continue;
    }
    if (CODE_EXTENSIONS.has(extname(entry.name))) {
      result.push(join(directory, entry.name));
    }
  }
  return result.sort();
}
