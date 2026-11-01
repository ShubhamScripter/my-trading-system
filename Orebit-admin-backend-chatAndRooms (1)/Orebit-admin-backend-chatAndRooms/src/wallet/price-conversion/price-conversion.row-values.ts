/** Converts a required database timestamp to the API's canonical ISO form. */
export function requiredIso(value: unknown): string {
  if (value === null || value === undefined) throw new Error('Expected timestamp');
  return new Date(value as string | number | Date).toISOString();
}

/** Preserves a nullable database timestamp while canonicalizing present values. */
export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredIso(value);
}

/** Preserves database nullability while normalizing present scalar values. */
export function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

const CURSOR_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.)(\d{6})Z$/;

/** Preserves the database's six fractional digits for opaque SQL cursor comparisons. */
export function requiredCursorTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !CURSOR_TIMESTAMP.test(value)) {
    throw new Error('Expected exact cursor timestamp');
  }
  const milliseconds = value.replace(/(\.\d{3})\d{3}Z$/, '$1Z');
  const parsed = new Date(milliseconds);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== milliseconds) {
    throw new Error('Expected exact cursor timestamp');
  }
  return value;
}

export function isCursorTimestamp(value: string): boolean {
  try { requiredCursorTimestamp(value); return true; } catch { return false; }
}
