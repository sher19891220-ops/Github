'use client';

import { useEffect, useState } from 'react';
import { getOverheadRates } from './data/api';
import { errorMessageFor, isEmptyList, loaded, loading, errored, type FetchState } from './data/fetchState';
import type { TruckOverheadRate } from './data/types';
import { formatMoney, formatRate } from './format/decimal';

/**
 * Read-only per-truck registration overhead: annual, monthly (the posted
 * figure), and weekly/daily (analysis rates only — see `overheadRate.ts`).
 * The engine already computes every number here; this renders it, with the
 * analysis-vs-posted distinction kept visible rather than flattened into
 * one column, because presenting a derived rate as if it were a posted
 * actual is exactly what CLAUDE.md §2 forbids.
 */
export function OverheadTable() {
  const [state, setState] = useState<FetchState<TruckOverheadRate[]>>(loading());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState(loading());
    getOverheadRates()
      .then((r) => {
        if (!cancelled) setState(loaded(r));
      })
      .catch((err) => {
        if (!cancelled) setState(errored(errorMessageFor(err, 'Could not load overhead rates.')));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (state.status === 'loading') {
    return <p style={{ color: 'var(--muted)' }}>Loading overhead rates…</p>;
  }

  if (state.status === 'error') {
    return (
      <div role="alert" style={{ color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 8, padding: '0.75rem' }}>
        <p style={{ margin: 0, fontWeight: 600 }}>Could not load overhead rates</p>
        <p style={{ margin: '0.25rem 0 0' }}>{state.message}</p>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} style={{ marginTop: '0.5rem' }}>
          Retry
        </button>
      </div>
    );
  }

  if (isEmptyList(state)) {
    return <p style={{ color: 'var(--muted)' }}>No registration overhead has been posted yet.</p>;
  }

  const rates = state.data;

  return (
    <div>
      <p style={{ color: 'var(--muted)', maxWidth: 640 }}>
        Annual cost is the actual, reconciled invoice amount (IRP + HVUT), evenly split per unit —
        an <strong>allocation</strong>, not a per-truck actual (no per-unit breakdown exists on the
        invoice itself; see the memo on each posted entry). Monthly is the figure actually posted to
        the ledger. Weekly and daily are analysis rates derived from the annual total — they are{' '}
        <strong>never posted</strong>.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--line)' }}>
            <th style={th}>Truck</th>
            <th style={th}>Entity</th>
            <th style={th}>Coverage</th>
            <th style={th}>Cost streams</th>
            <th style={{ ...th, textAlign: 'right' }}>Annual (allocated)</th>
            <th style={{ ...th, textAlign: 'right' }}>Monthly (posted)</th>
            <th style={{ ...th, textAlign: 'right' }}>Weekly (analysis)</th>
            <th style={{ ...th, textAlign: 'right' }}>Daily (analysis)</th>
          </tr>
        </thead>
        <tbody>
          {rates.map((r) => (
            <tr key={`${r.truckId ?? r.unitNumber}`} style={{ borderBottom: '1px solid var(--line)' }}>
              <td style={td}>
                {r.unitNumber}
                {r.truckId == null && (
                  <div style={{ color: 'var(--warn)', fontSize: '0.8em' }}>unresolved truck id — VIN {r.vin}</div>
                )}
              </td>
              <td style={td}>{r.entityId}</td>
              <td style={td}>
                {r.coverageStart} → {r.coverageEnd} ({r.coverageDays}d)
              </td>
              <td style={{ ...td, color: 'var(--muted)', fontSize: '0.85em' }}>{r.categoryIds.join(', ')}</td>
              <td className="num" style={td}>
                {formatMoney(r.annualTotal)}
                <span
                  style={{
                    marginLeft: '0.4em',
                    fontSize: '0.75em',
                    color: 'var(--warn)',
                    border: '1px solid var(--warn)',
                    borderRadius: 4,
                    padding: '0 0.3em',
                  }}
                >
                  allocated
                </span>
              </td>
              <td className="num" style={td}>{formatMoney(r.monthlyLedger)}</td>
              <td className="num" style={td}>
                {formatRate(r.weeklyRate)}
                <span style={{ marginLeft: '0.4em', fontSize: '0.75em', color: 'var(--muted)' }}>never posted</span>
              </td>
              <td className="num" style={td}>
                {formatRate(r.dailyRate)}
                <span style={{ marginLeft: '0.4em', fontSize: '0.75em', color: 'var(--muted)' }}>never posted</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '0.5rem', color: 'var(--muted)', fontWeight: 600 };
const td: React.CSSProperties = { padding: '0.5rem', verticalAlign: 'top' };
