import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDecimal } from '@/contract/types';
import { errorMessageFor, errored, isEmptyList, loaded, loading } from '@/components/data/fetchState';
import { DOC_TYPE_OPTIONS, inferDocType } from '@/components/data/inferDocType';
import { FINANCIAL_SNAPSHOT, WORK_QUEUE } from '@/components/dashboard/snapshot';

describe('fetchState — loading / error / loaded-but-empty stay distinct', () => {
  it('loading and error are never mistaken for an empty successful load', () => {
    expect(isEmptyList(loading<string[]>())).toBe(false);
    expect(isEmptyList(errored<string[]>('boom'))).toBe(false);
  });

  it('isEmptyList is true only for a loaded state with a zero-length array', () => {
    expect(isEmptyList(loaded<string[]>([]))).toBe(true);
    expect(isEmptyList(loaded<string[]>(['a']))).toBe(false);
  });

  it('the three states carry the payload a screen needs and nothing else', () => {
    const l = loaded({ a: 1 });
    expect(l).toEqual({ status: 'loaded', data: { a: 1 } });
    const e = errored('could not reach the server');
    expect(e).toEqual({ status: 'error', message: 'could not reach the server' });
    expect(loading()).toEqual({ status: 'loading' });
  });

  it('errorMessageFor prefers a real Error message and falls back otherwise', () => {
    expect(errorMessageFor(new Error('network down'), 'fallback')).toBe('network down');
    expect(errorMessageFor(new Error(''), 'fallback')).toBe('fallback');
    expect(errorMessageFor('a string throw', 'fallback')).toBe('fallback');
    expect(errorMessageFor(undefined, 'fallback')).toBe('fallback');
  });
});

describe('inferDocType — a best-effort default, never authoritative', () => {
  it('picks toll/maintenance/fuel from the file name, case-insensitively', () => {
    expect(inferDocType('TOLL-violations-jan.csv')).toBe('toll');
    expect(inferDocType('Truck_Maintenance_Q1.xlsx')).toBe('maintenance');
    expect(inferDocType('expenses-2026.pdf')).toBe('maintenance');
    expect(inferDocType('efs-statement.pdf')).toBe('fuel');
  });

  it('every option in the picker is a real DocType the contract defines', () => {
    const values = DOC_TYPE_OPTIONS.map((o) => o.value);
    expect(values).toEqual(['fuel', 'toll', 'maintenance']);
  });
});

describe('dashboard snapshot — every money figure is a real decimal string', () => {
  it('every financial tile amount is a valid decimal, never a JS number', () => {
    for (const tile of FINANCIAL_SNAPSHOT) {
      expect(isDecimal(tile.amount)).toBe(true);
      expect(tile.isLive).toBe(false);
    }
  });

  it('every work queue item has a non-empty count and a label', () => {
    for (const item of WORK_QUEUE) {
      expect(item.count.length).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it('the not-actionable item (fuel/IFTA) has no link and sorts last, largest first', () => {
    const fuel = WORK_QUEUE.find((i) => i.id === 'fuel-ifta-unusable');
    expect(fuel?.href).toBeNull();
    const sorted = [...WORK_QUEUE].sort((a, b) => b.weight - a.weight);
    expect(sorted[sorted.length - 1]?.id).toBe('fuel-ifta-unusable');
    // Every actionable item does link somewhere.
    for (const item of WORK_QUEUE) {
      if (item.id !== 'fuel-ifta-unusable') expect(item.href).not.toBeNull();
    }
  });
});

describe('httpApi — the real fetch client', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  function mockFetchOnce(status: number, body: unknown, ok = status >= 200 && status < 300) {
    global.fetch = vi.fn().mockResolvedValue({
      ok,
      status,
      statusText: 'status text',
      json: async () => body,
    } as Response);
  }

  it('listDocuments returns the documents array from a 200 response', async () => {
    mockFetchOnce(200, { documents: [{ documentId: 'd1' }] });
    const { listDocuments } = await import('@/components/data/httpApi');
    const docs = await listDocuments();
    expect(docs).toEqual([{ documentId: 'd1' }]);
  });

  it('getDocument returns null on a 404, distinct from throwing', async () => {
    mockFetchOnce(404, { error: 'document x not found' }, false);
    const { getDocument } = await import('@/components/data/httpApi');
    await expect(getDocument('x')).resolves.toBeNull();
  });

  it('getDocument throws a real ApiError (not null) on a 500', async () => {
    mockFetchOnce(500, { error: 'db is down' }, false);
    const { getDocument, ApiError } = await import('@/components/data/httpApi');
    await expect(getDocument('x')).rejects.toBeInstanceOf(ApiError);
    await expect(getDocument('x')).rejects.toThrow('db is down');
  });

  it('a network failure (fetch itself throws) becomes an ApiError with status null, never a silent empty result', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const { listDocuments, ApiError } = await import('@/components/data/httpApi');
    let caught: unknown;
    try {
      await listDocuments();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as InstanceType<typeof ApiError>).status).toBeNull();
    expect((caught as Error).message).toMatch(/could not reach the server/i);
  });

  it('patchStagingRow surfaces a 422 validation failure rather than swallowing it into null', async () => {
    mockFetchOnce(422, { error: 'invalid edit body' }, false);
    const { patchStagingRow, ApiError } = await import('@/components/data/httpApi');
    await expect(patchStagingRow('row-1', { amount: 'not-a-number' })).rejects.toBeInstanceOf(ApiError);
  });

  it('commitDocument returns the CommitResult on success', async () => {
    mockFetchOnce(200, { committed: 3, rejected: 1, entryIds: ['e1', 'e2', 'e3'] });
    const { commitDocument } = await import('@/components/data/httpApi');
    await expect(commitDocument('doc-1')).resolves.toEqual({ committed: 3, rejected: 1, entryIds: ['e1', 'e2', 'e3'] });
  });

  it('commitDocument throws on failure — the caller must not assume a partial success', async () => {
    mockFetchOnce(500, { error: 'transaction rolled back' }, false);
    const { commitDocument } = await import('@/components/data/httpApi');
    await expect(commitDocument('doc-1')).rejects.toThrow('transaction rolled back');
  });

  it('uploadDocument normalizes a missing duplicateOf to null, not undefined', async () => {
    mockFetchOnce(201, { documentId: 'doc-2', sha256: 'abc' });
    const { uploadDocument } = await import('@/components/data/httpApi');
    const file = new File(['hello'], 'fuel.csv', { type: 'text/csv' });
    const result = await uploadDocument({ file, docType: 'fuel' });
    expect(result).toEqual({ documentId: 'doc-2', sha256: 'abc', duplicateOf: null });
  });
});
