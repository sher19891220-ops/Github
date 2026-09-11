'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ChargebackDecision, ChargebackRow, ChargedTo, SplitRatio } from './data/types';
import { dataSource, getChargebackQueue, postBulkChargebackDecision } from './data/api';
import { invalidDecisionReason, isValidDecision, needsDecision, runningDriverTotals } from './chargeback/logic';
import { formatMoney } from './format/decimal';
import { StatusPill } from './StatusPill';

function sourceLabel(row: ChargebackRow): string {
  return row.sourceRef.kind === 'document'
    ? row.sourceRef.label
    : `${row.sourceRef.label} · ${row.sourceRef.rowRef}`;
}

function chargedToPill(chargedTo: ChargedTo) {
  switch (chargedTo) {
    case 'company':
      return <StatusPill label="Company" tone="good" />;
    case 'driver':
      return <StatusPill label="Driver" tone="warn" />;
    case 'split':
      return <StatusPill label="Split" tone="warn" />;
    case 'unknown':
      return <StatusPill label="Unknown" tone="bad" />;
  }
}

/**
 * The decision queue for the 713-row `charged_to = unknown` backlog.
 * Densest-first by default (same driver+vendor rows cluster together so a
 * bulk decision clears the most rows at once), select-many + one bulk
 * decision, and a split is refused without a ratio. Keyboard-first: Up/Down
 * moves the row cursor, Space toggles selection, `a` applies the pending
 * decision to the whole selection.
 */
export function ChargebackQueue() {
  const [rows, setRows] = useState<ChargebackRow[] | null>(null);
  const [actor, setActor] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [chargedTo, setChargedTo] = useState<ChargedTo>('company');
  const [splitKind, setSplitKind] = useState<'amount' | 'percentage'>('percentage');
  const [splitValue, setSplitValue] = useState('');
  const [note, setNote] = useState('');
  const [applying, setApplying] = useState(false);
  const [onlyUndecided, setOnlyUndecided] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getChargebackQueue().then((r) => {
      if (!cancelled) setRows(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    if (!rows) return [];
    return onlyUndecided ? rows.filter(needsDecision) : rows;
  }, [rows, onlyUndecided]);

  const driverTotals = useMemo(() => (rows ? runningDriverTotals(rows) : new Map<string, string>()), [rows]);

  const splitRatio: SplitRatio | null =
    chargedTo === 'split' ? { kind: splitKind, driverShare: splitValue.trim() || '0' } : null;
  const decision: Pick<ChargebackDecision, 'chargedTo' | 'splitRatio'> = { chargedTo, splitRatio };
  const decisionError = invalidDecisionReason(decision);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(visible.length - 1, 0)));
  }, [visible.length]);

  function toggle(costRowId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(costRowId)) next.delete(costRowId);
      else next.add(costRowId);
      return next;
    });
  }

  function selectGroupAtCursor() {
    const row = visible[cursor];
    if (!row) return;
    const key = `${row.driverId ?? ''}::${(row.vendor ?? '').trim().toLowerCase()}`;
    const groupIds = visible
      .filter((r) => `${r.driverId ?? ''}::${(r.vendor ?? '').trim().toLowerCase()}` === key)
      .map((r) => r.costRowId);
    setSelected(new Set(groupIds));
  }

  async function apply() {
    if (!actor.trim() || selected.size === 0 || decisionError) return;
    setApplying(true);
    try {
      const fullDecision: ChargebackDecision = {
        chargedTo,
        splitRatio,
        note: note.trim() || null,
        decidedBy: actor.trim(),
        decidedAt: new Date().toISOString(),
      };
      const updated = await postBulkChargebackDecision([...selected], fullDecision);
      setRows((prev) => {
        if (!prev) return prev;
        const byId = new Map(updated.map((r) => [r.costRowId, r]));
        return prev.map((r) => byId.get(r.costRowId) ?? r);
      });
      setSelected(new Set());
    } finally {
      setApplying(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (visible.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === ' ') {
      e.preventDefault();
      const row = visible[cursor];
      if (row) toggle(row.costRowId);
    } else if (e.key === 'g') {
      e.preventDefault();
      selectGroupAtCursor();
    } else if (e.key === 'a') {
      e.preventDefault();
      void apply();
    }
  }

  if (rows === null) {
    return <p style={{ color: 'var(--muted)' }}>Loading chargeback queue…</p>;
  }

  return (
    <div>
      {dataSource.chargeback === 'mock' && (
        <div role="note" className="sample-data-banner">
          Sample data — there is no live chargeback endpoint yet. Nothing on this screen is a real
          balance; it exists to demonstrate the decision workflow only.
        </div>
      )}
      <p style={{ color: 'var(--muted)', maxWidth: 760 }}>
        Rows still needing a chargeback decision, densest driver+vendor cluster first — select a group (
        <kbd>g</kbd> at the highlighted row) and apply one decision to all of it. A repair charged back to a
        lease-to-own driver is not a company cost; get this wrong and lease-to-own margin and cost-per-truck are
        both wrong.
      </p>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', margin: '0.5rem 0 1rem' }}>
        <label style={{ color: 'var(--muted)', fontSize: '0.9em' }}>
          Your name{' '}
          <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="e.g. J. Reyes" style={{ marginLeft: '0.4rem', padding: '0.15rem 0.4rem' }} />
        </label>
        <label style={{ color: 'var(--muted)', fontSize: '0.9em' }}>
          <input type="checkbox" checked={onlyUndecided} onChange={(e) => setOnlyUndecided(e.target.checked)} /> Only
          undecided
        </label>
        <div style={{ marginLeft: 'auto', color: 'var(--muted)' }}>
          <strong className="num">{rows.filter(needsDecision).length}</strong> of{' '}
          <strong className="num">{rows.length}</strong> still unknown
        </div>
      </div>

      <div
        style={{
          border: '1px solid var(--line)',
          borderRadius: 8,
          padding: '0.75rem',
          marginBottom: '1rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ color: 'var(--muted)', fontSize: '0.85em' }}>Charge to</div>
          <select value={chargedTo} onChange={(e) => setChargedTo(e.target.value as ChargedTo)}>
            <option value="company">Company</option>
            <option value="driver">Driver</option>
            <option value="split">Split</option>
          </select>
        </div>
        {chargedTo === 'split' && (
          <>
            <div>
              <div style={{ color: 'var(--muted)', fontSize: '0.85em' }}>Split kind</div>
              <select value={splitKind} onChange={(e) => setSplitKind(e.target.value as 'amount' | 'percentage')}>
                <option value="percentage">Driver % </option>
                <option value="amount">Driver $ amount</option>
              </select>
            </div>
            <div>
              <div style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
                Driver share{splitKind === 'percentage' ? ' (%)' : ' ($)'}
              </div>
              <input
                value={splitValue}
                onChange={(e) => setSplitValue(e.target.value)}
                placeholder={splitKind === 'percentage' ? '60.00' : '200.00'}
                style={{ width: '7em', padding: '0.15rem 0.4rem' }}
              />
            </div>
          </>
        )}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ color: 'var(--muted)', fontSize: '0.85em' }}>Note (optional)</div>
          <input value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%', padding: '0.15rem 0.4rem' }} />
        </div>
        <div>
          <button
            type="button"
            disabled={!actor.trim() || selected.size === 0 || !!decisionError || applying}
            onClick={apply}
            title={decisionError ?? (selected.size === 0 ? 'Select at least one row' : undefined)}
          >
            {applying ? 'Applying…' : `Apply to ${selected.size} row${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
        {decisionError && chargedTo === 'split' && (
          <p role="alert" style={{ color: 'var(--bad)', width: '100%', margin: 0 }}>{decisionError}</p>
        )}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }} role="grid" tabIndex={0} onKeyDown={onKeyDown}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--line)' }}>
            <th style={th}></th>
            <th style={th}>Unit</th>
            <th style={th}>Driver</th>
            <th style={th}>Class</th>
            <th style={th}>Vendor</th>
            <th style={th}>Description</th>
            <th style={th}>Date</th>
            <th style={{ ...th, textAlign: 'right' }}>Amount</th>
            <th style={th}>Charged to</th>
            <th style={th}>Driver owes (running)</th>
            <th style={th}>Source</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row, i) => (
            <tr
              key={row.costRowId}
              aria-selected={selected.has(row.costRowId)}
              onClick={() => setCursor(i)}
              style={{
                borderBottom: '1px solid var(--line)',
                background: i === cursor ? 'var(--focus-bg)' : selected.has(row.costRowId) ? 'var(--select-bg)' : undefined,
              }}
            >
              <td style={td}>
                <input type="checkbox" checked={selected.has(row.costRowId)} onChange={() => toggle(row.costRowId)} />
              </td>
              <td style={td}>{row.truckId ?? '—'}</td>
              <td style={td}>{row.driverId ?? '—'}</td>
              <td style={td}>{row.driverClass ?? '—'}</td>
              <td style={td}>{row.vendor ?? '—'}</td>
              <td style={td}>{row.description ?? '—'}</td>
              <td style={td}>{row.accrualDate ?? '—'}</td>
              <td className="num" style={td}>{formatMoney(row.amount)}</td>
              <td style={td}>{chargedToPill(row.chargedTo)}</td>
              <td className="num" style={td}>
                {row.driverId ? formatMoney(driverTotals.get(row.driverId) ?? '0.00') : '—'}
              </td>
              <td style={{ ...td, color: 'var(--muted)', fontSize: '0.85em' }}>{sourceLabel(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {visible.length === 0 && <p style={{ color: 'var(--good)' }}>Nothing left in this filter — queue is clear.</p>}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '0.4rem', color: 'var(--muted)', fontWeight: 600 };
const td: React.CSSProperties = { padding: '0.35rem 0.4rem', verticalAlign: 'top' };
