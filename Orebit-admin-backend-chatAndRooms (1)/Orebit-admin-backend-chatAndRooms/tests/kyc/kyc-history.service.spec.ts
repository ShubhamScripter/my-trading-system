import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../src/contracts';
import { encodeKycHistoryCursor } from '../../src/kyc/kyc-history.cursor';
import { KycHistoryService } from '../../src/kyc/kyc-history.service';
import { makePrincipal } from '../harness';

/**
 * The KYC history service against doubles.
 *
 * ═══ WHAT THIS SURFACE MUST NEVER DO ═══════════════════════════════════════
 *
 * It returns a platform user's identity-verification history to an administrator, so
 * most of what is proved here is about restraint rather than behaviour: it writes
 * nothing, it leaks no sealed PII and no provider payload, it reads the level off the
 * persisted row rather than off anything a caller or the provider supplied, and it
 * never reinterprets a state the consumer's machine produced.
 *
 * It also must not participate in renewal. Querying history cannot expire a credential,
 * cannot start a session and cannot evaluate a policy — whatever X and Y are set to,
 * including the shipped state where both are null and renewal is off entirely.
 */

const ACTOR = makePrincipal({ adminId: '0195f0a0-aaaa-7000-8000-000000000001' });
const CLIENT = { ip: '203.0.113.10', userAgent: 'vitest', acceptLanguage: 'en' } as never;
const USER = '01a07052-0000-7000-8000-000000000001';

/** Microsecond text, exactly as the SQL renders `created_at` for the cursor. */
function at(iso: string): string {
  return `${iso}.000000Z`;
}

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '01a0af06-dbf9-7e09-937d-73ea819b23d3',
    user_id: USER,
    level: 'L1',
    status: 'APPROVED',
    provider_status: 'Approved',
    session_id: 'sess-1',
    workflow_id: 'wf-1',
    workflow_source: 'DIDIT_L1_WORKFLOW_ID',
    verified_country: 'DE',
    aml_status: null,
    aml_total_hits: null,
    document_type: 'Identity Card',
    document_subtype: 'ID_CARD_GENERIC',
    started_at: new Date('2026-09-15T12:00:00.000Z'),
    completed_at: new Date('2026-09-15T12:41:30.000Z'),
    expires_at: new Date('2026-09-22T12:00:00.000Z'),
    renewal_of_id: null,
    reconciled_at: null,
    updated_at: new Date('2026-09-15T12:41:30.000Z'),
    created_at: at('2026-09-15T12:00:00'),
    is_active_credential: true,
    ...overrides,
  };
}

let history: {
  list: ReturnType<typeof vi.fn>;
  findAttempt: ReturnType<typeof vi.fn>;
  devicesFor: ReturnType<typeof vi.fn>;
  eventsFor: ReturnType<typeof vi.fn>;
};
let events: { record: ReturnType<typeof vi.fn> };

function build(): KycHistoryService {
  return new KycHistoryService(history as never, events as never);
}

beforeEach(() => {
  history = {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    findAttempt: vi.fn(async () => null),
    devicesFor: vi.fn(async () => []),
    eventsFor: vi.fn(async () => []),
  };
  events = { record: vi.fn(async () => undefined) };
});

// ─── listing ────────────────────────────────────────────────────────────────

describe('listing attempts', () => {
  it('returns the repository`s standard empty page when there is no history', async () => {
    const payload = await build().list({ limit: 50 }, ACTOR, CLIENT);
    expect(payload).toEqual({ items: [], nextCursor: null });
  });

  it('returns every attempt, not just the one currently in force', async () => {
    // The whole point of a history table. A renewal replaces the CURRENT credential; it
    // does not remove the attempt it replaced, and this surface must keep showing both.
    history.list.mockResolvedValue({
      items: [
        attemptRow({ id: '01a0af06-0000-7000-8000-00000000000b', is_active_credential: true }),
        attemptRow({ id: '01a0af06-0000-7000-8000-00000000000a', is_active_credential: false }),
      ],
      nextCursor: null,
    });

    const payload = await build().list({ limit: 50 }, ACTOR, CLIENT);

    expect(payload.items).toHaveLength(2);
    expect(payload.items.map((i) => i.isActiveCredential)).toEqual([true, false]);
  });

  it('marks a superseded success as no longer in force, without hiding it', async () => {
    history.list.mockResolvedValue({
      items: [attemptRow({ status: 'APPROVED', is_active_credential: false })],
      nextCursor: null,
    });

    const [item] = (await build().list({ limit: 50 }, ACTOR, CLIENT)).items;
    expect(item?.status).toBe('APPROVED');
    expect(item?.isActiveCredential).toBe(false);
  });

  it('treats a null join result as "not in force" rather than leaking null', async () => {
    history.list.mockResolvedValue({
      items: [attemptRow({ is_active_credential: null })],
      nextCursor: null,
    });
    expect((await build().list({ limit: 50 }, ACTOR, CLIENT)).items[0]?.isActiveCredential)
      .toBe(false);
  });

  it('passes only the filters that were supplied', async () => {
    await build().list({ limit: 25, userId: USER, level: 'L2' }, ACTOR, CLIENT);

    expect(history.list).toHaveBeenCalledWith({ limit: 25, userId: USER, level: 'L2' });
    const passed = history.list.mock.calls[0]?.[0] as Record<string, unknown>;
    // Absent rather than explicitly undefined: an undefined key would become a
    // `WHERE status = NULL` the moment someone stopped checking for it.
    expect('status' in passed).toBe(false);
    expect('cursor' in passed).toBe(false);
  });

  it('hands the cursor straight through and reports the next one', async () => {
    const cursor = encodeKycHistoryCursor(at('2026-09-15T12:00:00'), attemptRow().id);
    history.list.mockResolvedValue({ items: [attemptRow()], nextCursor: 'next-page' });

    const payload = await build().list({ limit: 50, cursor }, ACTOR, CLIENT);

    expect(history.list).toHaveBeenCalledWith(expect.objectContaining({ cursor }));
    expect(payload.nextCursor).toBe('next-page');
  });
});

// ─── levels stay where they were persisted ──────────────────────────────────

describe('L1 and L2 remain isolated', () => {
  it('reports the level from the persisted row, verbatim', async () => {
    history.list.mockResolvedValue({
      items: [attemptRow({ level: 'L1' }), attemptRow({ level: 'L2' })],
      nextCursor: null,
    });

    const payload = await build().list({ limit: 50 }, ACTOR, CLIENT);
    expect(payload.items.map((i) => i.level)).toEqual(['L1', 'L2']);
  });

  it('never derives a level from the workflow, the session or the query', async () => {
    // A row whose workflow name says one thing and whose persisted level says another.
    // The persisted column wins — the same invariant the webhook path holds, where
    // `vendor_data` and `metadata.level` are ignored in favour of the row.
    history.list.mockResolvedValue({
      items: [attemptRow({ level: 'L1', workflow_source: 'DIDIT_L2_WORKFLOW_ID', session_id: 'l2-looking-session' })],
      nextCursor: null,
    });

    const [item] = (await build().list({ limit: 50, level: 'L2' }, ACTOR, CLIENT)).items;
    expect(item?.level).toBe('L1');
  });
});

// ─── the review lifecycle is reported, not reinterpreted ────────────────────

describe('IN_REVIEW', () => {
  it('is reported as IN_REVIEW, never as EXPIRED', async () => {
    // Even when the hosted session window has already passed — which is the ordinary
    // case for a manual review, since reviews routinely outlast seven days. Step 7 stops
    // the consumer from closing those rows; this surface must not undo that by
    // relabelling them.
    history.list.mockResolvedValue({
      items: [
        attemptRow({
          status: 'IN_REVIEW',
          provider_status: 'In Review',
          completed_at: null,
          expires_at: new Date('2026-09-01T00:00:00.000Z'),
          is_active_credential: false,
        }),
      ],
      nextCursor: null,
    });

    const [item] = (await build().list({ limit: 50 }, ACTOR, CLIENT)).items;
    expect(item?.status).toBe('IN_REVIEW');
    expect(item?.providerStatus).toBe('In Review');
    expect(item?.completedAt).toBeNull();
  });

  it('shows the SAME attempt as APPROVED once the reviewer decides', async () => {
    // One attempt, one row, transitioned in place — not a second record. The history
    // view reflects whatever the consumer's state machine last wrote.
    history.list.mockResolvedValue({
      items: [attemptRow({ id: 'same-row', status: 'APPROVED', provider_status: 'Approved', is_active_credential: true } as never)],
      nextCursor: null,
    });

    const [item] = (await build().list({ limit: 50 }, ACTOR, CLIENT)).items;
    expect(item?.status).toBe('APPROVED');
    expect(item?.isActiveCredential).toBe(true);
  });
});

// ─── the two expiries are named apart ───────────────────────────────────────

describe('provider session expiry is not KYC validity', () => {
  it('renames expires_at so it cannot be read as a renewal deadline', async () => {
    history.list.mockResolvedValue({ items: [attemptRow()], nextCursor: null });
    const [item] = (await build().list({ limit: 50 }, ACTOR, CLIENT)).items;

    expect(item?.providerSessionExpiresAt).toBe('2026-09-22T12:00:00.000Z');
    // No field on this payload claims to be a KYC validity deadline, because a deadline
    // belongs to a LEVEL and this is a record of an ATTEMPT.
    expect(item).not.toHaveProperty('expiresAt');
    expect(item).not.toHaveProperty('mandatoryRenewalAt');
  });
});

// ─── the detail view ────────────────────────────────────────────────────────

describe('one attempt in detail', () => {
  beforeEach(() => {
    history.findAttempt.mockResolvedValue(attemptRow());
    history.devicesFor.mockResolvedValue([
      { sequence: 0, ip_address: '203.0.113.5', user_agent: 'Chrome', device_fingerprint: 'fp-1',
        browser_family: 'Chrome', os_family: 'Windows', platform: 'desktop',
        is_vpn_or_tor: false, is_data_center: false },
    ]);
    history.eventsFor.mockResolvedValue([
      { event_id: 'evt-1', event_type: 'status.updated', received_at: new Date('2026-09-15T12:41:00.000Z'),
        processed_at: new Date('2026-09-15T12:41:01.000Z'), processing_status: 'PROCESSED',
        error: null, signature_variant: 'raw' },
    ]);
  });

  it('returns the attempt with its devices and provider deliveries', async () => {
    const payload = await build().attempt({ verificationId: attemptRow().id }, ACTOR, CLIENT);

    expect(payload.attempt.verificationId).toBe(attemptRow().id);
    expect(payload.devices).toHaveLength(1);
    expect(payload.providerEvents).toHaveLength(1);
    expect(payload.providerEvents[0]?.processingStatus).toBe('PROCESSED');
  });

  it('correlates provider events by the attempt`s OWN session id', async () => {
    await build().attempt({ verificationId: attemptRow().id }, ACTOR, CLIENT);
    expect(history.eventsFor).toHaveBeenCalledWith('sess-1');
  });

  it('answers 404 for an unknown attempt rather than an empty shape', async () => {
    // An empty payload would read as "this attempt had no devices" rather than "there
    // is no such attempt".
    history.findAttempt.mockResolvedValue(null);

    await expect(
      build().attempt({ verificationId: attemptRow().id }, ACTOR, CLIENT),
    ).rejects.toMatchObject({ type: ERR.NOT_FOUND });
  });

  it('does not look up devices or events for an attempt that does not exist', async () => {
    history.findAttempt.mockResolvedValue(null);
    await expect(
      build().attempt({ verificationId: attemptRow().id }, ACTOR, CLIENT),
    ).rejects.toThrow();

    expect(history.devicesFor).not.toHaveBeenCalled();
    expect(history.eventsFor).not.toHaveBeenCalled();
  });
});

// ─── disclosure ─────────────────────────────────────────────────────────────

describe('what is never returned', () => {
  it('exposes no sealed document number or name, even if the row carried one', async () => {
    // The projection is an allow-list, so these cannot be selected — but the row double
    // carries them anyway, to prove the view drops rather than merely omits them.
    history.list.mockResolvedValue({
      items: [attemptRow({
        document_number_ciphertext: Buffer.from('secret'),
        full_name_ciphertext: Buffer.from('Jane Doe'),
        full_name_iv: Buffer.from('iv'),
      })],
      nextCursor: null,
    });

    const [item] = (await build().list({ limit: 50 }, ACTOR, CLIENT)).items;
    const serialised = JSON.stringify(item);

    for (const leaked of ['documentNumber', 'document_number', 'fullName', 'full_name', 'ciphertext', 'Jane Doe']) {
      expect(serialised, `leaked ${leaked}`).not.toContain(leaked);
    }
    // The unsealed type IS exposed — it identifies nobody on its own, and a number
    // without its type is ambiguous between a passport and a national id.
    expect(item?.documentType).toBe('Identity Card');
  });

  it('exposes no raw webhook payload, only the delivery summary', async () => {
    history.findAttempt.mockResolvedValue(attemptRow());
    history.eventsFor.mockResolvedValue([
      { event_id: 'evt-1', event_type: 'status.updated', received_at: new Date(),
        processed_at: null, processing_status: 'PENDING', error: null, signature_variant: 'raw',
        payload: { decision: { full_name: 'Jane Doe', date_of_birth: '1990-01-01' } } },
    ]);

    const payload = await build().attempt({ verificationId: attemptRow().id }, ACTOR, CLIENT);
    const serialised = JSON.stringify(payload.providerEvents);

    expect(serialised).not.toContain('payload');
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('date_of_birth');
    // The variant NAME is fine — it is which header authenticated the delivery, never
    // a signature and never a secret.
    expect(payload.providerEvents[0]?.signatureVariant).toBe('raw');
  });

  it('never selects a sealed column in the first place', () => {
    // Comments stripped: the projection's own doc comment says the words "SELECT *" to
    // explain why it is an allow-list, and scanning raw text flags the explanation as
    // though it were the defect. Executable SQL is what must be clean.
    const source = readFileSync('src/kyc/kyc-history.dboperation.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const column of [
      'document_number_ciphertext', 'document_number_iv', 'document_number_tag',
      'full_name_ciphertext', 'full_name_iv', 'full_name_tag',
      'v."payload"', 'SELECT *',
    ]) {
      expect(source, `selects ${column}`).not.toContain(column);
    }
  });
});

// ─── read-only, and audited ─────────────────────────────────────────────────

describe('the surface is read-only', () => {
  it('issues no mutating statement anywhere in its persistence layer', () => {
    // Comments are stripped so prose describing the boundary is not mistaken for a
    // breach of it.
    const source = readFileSync('src/kyc/kyc-history.dboperation.ts', 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const statement of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+"/i, /\bDELETE\b/i, /\$executeRaw/]) {
      expect(code).not.toMatch(statement);
    }
  });

  it('never evaluates renewal, so a query cannot expire anybody', async () => {
    // The strongest form of "querying history does not trigger renewal": the service
    // has no path to the periods or the evaluator at all. With X and Y null — the
    // shipped state — there is nothing to evaluate either way, and this holds whatever
    // they are set to.
    const source = readFileSync('src/kyc/kyc-history.service.ts', 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const forbidden of ['findRenewalPeriods', 'mandatoryPeriod', 'voluntaryPeriod', 'renewalIsDue', 'kyc_level_states']) {
      expect(code, `reaches ${forbidden}`).not.toContain(forbidden);
    }

    await build().list({ limit: 50 }, ACTOR, CLIENT);
    expect(history.list).toHaveBeenCalledTimes(1);
  });

  it('records WHO looked and at WHAT FILTER, never the rows returned', async () => {
    history.list.mockResolvedValue({ items: [attemptRow()], nextCursor: null });
    await build().list({ limit: 50, userId: USER, level: 'L1', status: 'APPROVED' }, ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ADMIN_KYC_HISTORY_VIEWED',
        adminId: ACTOR.adminId,
        metadata: expect.objectContaining({
          scope: 'list', userId: USER, level: 'L1', status: 'APPROVED', returned: 1,
        }),
      }),
    );

    // The rows themselves must not be copied into the audit table — that would
    // duplicate the very data the audit exists to govern.
    const metadata = JSON.stringify(
      (events.record.mock.calls[0]?.[0] as { metadata: unknown }).metadata,
    );
    expect(metadata).not.toContain('Identity Card');
    expect(metadata).not.toContain('sess-1');
  });

  it('audits the detail read too', async () => {
    history.findAttempt.mockResolvedValue(attemptRow());
    await build().attempt({ verificationId: attemptRow().id }, ACTOR, CLIENT);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ scope: 'attempt' }) }),
    );
  });
});
