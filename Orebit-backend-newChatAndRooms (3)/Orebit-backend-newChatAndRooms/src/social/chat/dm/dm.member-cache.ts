// A short-lived, in-process copy of each conversation's member list (Modules 8-9).
// Why: every message, typing signal and read receipt needs the members of its conversation. Before this cache each of
// them ran a members query (up to 100,000 rows) - 500 queries for one message in a 500-member group when everyone read
// it (handoff , ). Now one query serves every event of the conversation for a few seconds.
// Freshness: every write to dm_members goes through DmDbOperation / DmGroupsDbOperation, which call `invalidate`, so
// inside one server the cache is exact. Across servers it is at most `TTL_MS` behind ( allows ~5 seconds). Lists
// above `MAX_ROWS` are not kept (a huge group is read through aggregated paths, not per-event member lists).
// The timer is the steady clock (performance.now): it only decides cache freshness and never stores or shows a time.
import type { MemberRow } from './dm.dboperation';

const TTL_MS = 5_000;
const MAX_ROWS = 20_000;
const MAX_ENTRIES = 5_000;
const MAX_CACHED_ROWS = 100_000;

interface Entry {
  readonly at: number;
  readonly rows: readonly MemberRow[];
}

export class DmMemberCache {
  private readonly entries = new Map<string, Entry>();
  private totalRows = 0;
  private generation = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  // Every member of the conversation (all states), or undefined when not cached or too old.
  get(conversationId: string): readonly MemberRow[] | undefined {
    const entry = this.entries.get(conversationId);
    if (!entry) return undefined;
    if (this.now() - entry.at > TTL_MS) {
      this.delete(conversationId);
      return undefined;
    }
    this.entries.delete(conversationId);
    this.entries.set(conversationId, entry);
    return entry.rows;
  }

  version(): number {
    return this.generation;
  }

  set(conversationId: string, rows: readonly MemberRow[]): void {
    this.setIfVersion(conversationId, rows, this.generation);
  }

  setIfVersion(conversationId: string, rows: readonly MemberRow[], version: number): void {
    if (version !== this.generation || rows.length > MAX_ROWS || rows.length > MAX_CACHED_ROWS) return;
    this.delete(conversationId);
    while (this.entries.size >= MAX_ENTRIES || this.totalRows + rows.length > MAX_CACHED_ROWS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.delete(oldest);
    }
    this.entries.set(conversationId, { at: this.now(), rows });
    this.totalRows += rows.length;
  }

  invalidate(conversationId: string): void {
    this.generation += 1;
    this.delete(conversationId);
  }

  clear(): void {
    this.entries.clear();
    this.totalRows = 0;
    this.generation += 1;
  }

  get size(): number {
    return this.entries.size;
  }

  get rowCount(): number {
    return this.totalRows;
  }

  private delete(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    this.entries.delete(conversationId);
    this.totalRows -= entry.rows.length;
  }
}

// The one cache of the process.
export const dmMemberCache = new DmMemberCache();
