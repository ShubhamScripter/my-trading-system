import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The chat seed (chat.seed.ts) is a command-line script, so these checks read it next to the migrations: it must
 * clean every chat table (and only chat), never run in production, and leave accounts alone.
 */
const ROOT = join(__dirname, '..', '..');
const SEED = readFileSync(join(ROOT, 'src', 'social', 'chat', 'chat.seed.ts'), 'utf8');
const MIGRATIONS = join(ROOT, 'db', 'migrations');

function createdChatTables(): string[] {
  const sql = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8'))
    .join('\n');
  const names = [
    ...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?chat"?\."?([a-z_0-9]+)"?/gi),
  ].map((match) => match[1]!);
  // Monthly partitions and the table kept for the copy are cleaned with their parent.
  return [...new Set(names)].filter(
    (name) => !/^room_messages_(\d{4}_\d{2}|default|old)$/.test(name),
  );
}

function seedTables(): string[] {
  const list = SEED.match(/const CHAT_TABLES = \[([\s\S]*?)\] as const;/)?.[1] ?? '';
  return [...list.matchAll(/'([a-z_0-9]+)'/g)].map((match) => match[1]!);
}

describe('chat.seed.ts', () => {
  it('cleans every chat table the migrations create, so a reset leaves no chat row behind', () => {
    const missing = createdChatTables().filter((table) => !seedTables().includes(table));
    expect(missing).toEqual([]);
  });

  it('names no table that does not exist', () => {
    const real = new Set(createdChatTables());
    expect(seedTables().filter((table) => !real.has(table))).toEqual([]);
  });

  it('refuses to run in production', () => {
    expect(SEED).toMatch(/NODE_ENV === 'production'/);
    expect(SEED).toContain('never runs in production');
  });

  it('only touches the chat schema and chat Redis keys, never accounts or sessions', () => {
    expect(SEED).not.toMatch(/identity\./);
    expect(SEED).not.toMatch(/admin\./);
    expect(SEED).toMatch(/chat:/);
  });

  it('offers clean, seed, unseed and reset', () => {
    for (const command of ['clean', 'seed', 'unseed', 'reset']) {
      expect(SEED).toContain(`'${command}'`);
    }
  });
});
