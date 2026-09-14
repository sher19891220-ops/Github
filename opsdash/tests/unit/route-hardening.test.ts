/**
 * Input hardening at the route boundary.
 *
 * These are pure-logic tests of the two rules that came out of probing the
 * running server with malformed requests. Both were real, and one was
 * serious.
 */
import { describe, expect, it } from 'vitest';
import { badIdMessage, isUuid } from '@/lib/ids';

describe('isUuid', () => {
  it('accepts a real uuid in either case', () => {
    expect(isUuid('00000000-0000-4000-8000-00000000e001')).toBe(true);
    expect(isUuid('00000000-0000-4000-8000-00000000E001')).toBe(true);
    expect(isUuid('  00000000-0000-4000-8000-00000000e001  ')).toBe(true);
  });

  it('rejects everything a path parameter might otherwise carry', () => {
    // Unguarded, each of these reached Postgres, raised "invalid input
    // syntax for type uuid", and left the route as a 500 — the status
    // that means the server is broken, for a request that is merely
    // malformed.
    for (const bad of [
      'not-a-uuid',
      '',
      '../../etc/passwd',
      "1'; DROP TABLE accounting.ledger_entry; --",
      '00000000-0000-4000-8000',
      '00000000-0000-4000-8000-00000000e001x',
    ]) {
      expect(isUuid(bad), bad).toBe(false);
    }
  });
});

describe('badIdMessage', () => {
  it('says nothing about the schema beyond the shape of an id', () => {
    const m = badIdMessage('documentId');
    expect(m).toBe('documentId must be a UUID.');
    // An unhandled database error is the usual way a column name or a
    // type ends up in a response body.
    expect(m).not.toMatch(/accounting\.|postgres|syntax|column/i);
  });
});

/**
 * The P&L scope rule, as a pure function mirroring the route.
 *
 * The bug this encodes: `GET /api/pnl?entityId=X` with no `scope` returned
 * the whole GROUP's figures with `entityId: X` echoed back in the
 * response. Measured against real data, one company's revenue is
 * $27,355.54 and the group's is $39,929.06 — so the caller asking for one
 * company got a figure 46% too high, carrying that company's id. The UI
 * always sent `scope`, so it never surfaced there.
 */
function resolveScope(
  explicit: string | null,
  entityId: string | null,
  truckId: string | null,
): { scope: string } | { error: true } {
  const inferred = truckId ? 'truck' : entityId ? 'entity' : 'group';
  if (explicit !== null && explicit !== inferred) return { error: true };
  return { scope: explicit ?? inferred };
}

describe('P&L scope inference', () => {
  it('infers entity scope from an entityId', () => {
    expect(resolveScope(null, 'e1', null)).toEqual({ scope: 'entity' });
  });

  it('infers truck scope from a truckId, which is narrower than entity', () => {
    expect(resolveScope(null, 'e1', 't1')).toEqual({ scope: 'truck' });
  });

  it('stays group when nothing is filtered', () => {
    expect(resolveScope(null, null, null)).toEqual({ scope: 'group' });
  });

  it('refuses a stated scope that contradicts the filters', () => {
    // Answering either half silently is how a wrong number gets the right
    // label. Refusing is the only option that cannot mislead.
    expect(resolveScope('group', 'e1', null)).toEqual({ error: true });
    expect(resolveScope('entity', null, null)).toEqual({ error: true });
    expect(resolveScope('entity', 'e1', 't1')).toEqual({ error: true });
  });

  it('accepts a stated scope that agrees with them', () => {
    expect(resolveScope('entity', 'e1', null)).toEqual({ scope: 'entity' });
    expect(resolveScope('group', null, null)).toEqual({ scope: 'group' });
  });
});
