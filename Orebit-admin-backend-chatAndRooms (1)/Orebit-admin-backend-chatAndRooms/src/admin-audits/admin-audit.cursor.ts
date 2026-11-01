const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_MICROSECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function invalid(): never {
  throw new Error('INVALID_ADMIN_AUDIT_CURSOR');
}

export function isCanonicalAdminAuditTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.startsWith('0000-')) return false;
  const match = UTC_MICROSECOND.exec(value);
  if (!match) return false;
  const milliseconds = value.slice(0, 23) + 'Z';
  const parsed = new Date(milliseconds);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === milliseconds;
}

export function encodeAdminAuditCursor(createdAt: string, id: string): string {
  if (!isCanonicalAdminAuditTimestamp(createdAt) || !UUID_V7.test(id)) return invalid();
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

export function decodeAdminAuditCursor(cursor: string): readonly [string, string] {
  if (
    typeof cursor !== 'string'
    || cursor.length === 0
    || cursor.length > 512
    || !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }
  if (
    !Array.isArray(parsed)
    || parsed.length !== 2
    || !isCanonicalAdminAuditTimestamp(parsed[0])
    || typeof parsed[1] !== 'string'
    || !UUID_V7.test(parsed[1])
  ) return invalid();
  if (encodeAdminAuditCursor(parsed[0], parsed[1]) !== cursor) return invalid();
  return [parsed[0], parsed[1]];
}
