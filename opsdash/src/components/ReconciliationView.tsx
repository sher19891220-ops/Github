'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReconLine, ReconMatch, ReconciliationSet } from './data/types';
import { dataSource, getReconciliation, postReconDecision, type ReconDecisionAction } from './data/api';
import { formatMoney, formatQuantity } from './format/decimal';
import { isCollapsedByDefault, needsAttentionOrder, summarizeRecon } from './reconciliation/logic';

function lineSourceLabel(line: ReconLine | null): string {
  if (!line) return '—';
  switch (line.sourceRef.kind) {
    case 'document':
      return line.sourceRef.label;
    case 'ledger':
      return line.sourceRef.label;
    case 'sheet':
      return `${line.sourceRef.label} · ${line.sourceRef.rowRef}`;
  }
}

function LineCell({ line }: { line: ReconLine | null }) {
  if (!line) {
    return <span style={{ color: 'var(--muted)' }}>(no line on this side)</span>;
  }
  return (
    <div>
      <div>
        <strong>{line.truckId ?? '(no truck)'}</strong>{' '}
        <span style={{ color: 'var(--muted)' }}>{line.accrualDate ?? '(no date)'}</span>
      </div>
      <div className="num" style={{ marginTop: '0.1rem' }}>{formatMoney(line.amount)}</div>
      {line.quantity != null && (
        <div style={{ color: 'var(--muted)', fontSize: '0.85em' }}>{formatQuantity(line.quantity)} gal</div>
      )}
      <div style={{ color: 'var(--muted)', fontSize: '0.8em', marginTop: '0.15rem' }}>
        {lineSourceLabel(line)}
      </div>
    </div>
  );
}

function Totals({ summary }: { summary: ReturnType<typeof summarizeRecon> }) {
  const varianceTone =
    summary.netVariance === '0.00' ? 'var(--good)' : summary.netVariance.startsWith('-') ? 'var(--bad)' : 'var(--warn)';
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '1.25rem',
        padding: '0.75rem',
        marginBottom: '0.75rem',
        border: '1px solid var(--line)',
        borderRadius: 8,
      }}
    >
      <div>
        <strong className="num" style={{ color: 'var(--good)' }}>{summary.autoMatched + summary.confirmed}</strong> matched
      </div>
      <div>
        <strong className="num" style={{ color: summary.unmatchedDocument > 0 ? 'var(--warn)' : 'var(--muted)' }}>
          {summary.unmatchedDocument}
        </strong>{' '}
        unmatched — document
      </div>
      <div>
        <strong className="num" style={{ color: summary.unmatchedLedger > 0 ? 'var(--warn)' : 'var(--muted)' }}>
          {summary.unmatchedLedger}
        </strong>{' '}
        unmatched — ledger
      </div>
      <div>
        <strong className="num" style={{ color: 'var(--muted)' }}>{summary.nearMatch}</strong> near-match
      </div>
      <div style={{ marginLeft: 'auto' }}>
        Net variance: <strong className="num" style={{ color: varianceTone }}>{formatMoney(summary.netVariance)}</strong>
      </div>
    </div>
  );
}

/**
 * Two-sided reconciliation match view. The task brief's own framing: this
 * shrinks a hundred lines to the six that need a human, so the auto-matched
 * pile is collapsed by default and only near-matches / unmatched lines are
 * open on load. Keyboard-first: Up/Down moves through the "needs attention"
 * list, `c` confirms, `x` rejects, `m` opens the expected-missing note.
 */
export function ReconciliationView({ documentId }: { documentId: string }) {
  const [reconSet, setReconSet] = useState<ReconciliationSet | null>(null);
  const [actor, setActor] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [noteOpenFor, setNoteOpenFor] = useState<string | null>(null);
  const [showMatched, setShowMatched] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    getReconciliation(documentId).then((r) => {
      if (!cancelled) setReconSet(r);
    });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const summary = useMemo(() => (reconSet ? summarizeRecon(reconSet.matches) : null), [reconSet]);
  const attention = useMemo(() => (reconSet ? needsAttentionOrder(reconSet.matches) : []), [reconSet]);
  const resolved = useMemo(
    () => (reconSet ? reconSet.matches.filter((m) => m.status === 'auto_matched' || m.status === 'confirmed') : []),
    [reconSet],
  );
  const decided = useMemo(
    () => (reconSet ? reconSet.matches.filter((m) => m.status === 'rejected' || m.status === 'expected_missing') : []),
    [reconSet],
  );

  useEffect(() => {
    setFocusIndex((i) => Math.min(i, Math.max(attention.length - 1, 0)));
  }, [attention.length]);

  async function act(matchId: string, action: ReconDecisionAction) {
    if (!actor.trim()) return;
    setPendingId(matchId);
    try {
      const next = await postReconDecision(documentId, matchId, action, actor.trim());
      setReconSet((prev) => (prev ? { ...prev, matches: next } : prev));
    } finally {
      setPendingId(null);
      setNoteOpenFor(null);
    }
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (attention.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => Math.min(i + 1, attention.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => Math.max(i - 1, 0));
    } else {
      const row = attention[focusIndex];
      if (!row) return;
      if (e.key === 'c' && row.status === 'near_match') {
        e.preventDefault();
        void act(row.matchId, { type: 'confirm' });
      } else if (e.key === 'x') {
        e.preventDefault();
        void act(row.matchId, { type: 'reject' });
      } else if (e.key === 'm') {
        e.preventDefault();
        setNoteOpenFor(row.matchId);
      }
    }
  }

  if (reconSet === null || summary === null) {
    return <p style={{ color: 'var(--muted)' }}>Loading reconciliation…</p>;
  }

  return (
    <div>
      {dataSource.reconciliation === 'mock' && (
        <div role="note" className="sample-data-banner">
          Sample data — there is no live reconciliation endpoint yet. Matches below are generated from
          fixtures to demonstrate the workflow, not from real documents or the real ledger.
        </div>
      )}
      <p style={{ color: 'var(--muted)', maxWidth: 720 }}>
        <strong>{reconSet.documentLabel}</strong> vs. <strong>{reconSet.ledgerLabel}</strong>. Same unit, date and
        amount auto-matches and stays collapsed below; anything that does not line up — a variance or a line with no
        counterpart — is listed under &ldquo;Needs a decision&rdquo;.
      </p>

      <div style={{ margin: '0.5rem 0 0.75rem' }}>
        <label style={{ color: 'var(--muted)', fontSize: '0.9em' }}>
          Your name (required to confirm, reject or mark a line){' '}
          <input
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            placeholder="e.g. J. Reyes"
            style={{ marginLeft: '0.4rem', padding: '0.15rem 0.4rem' }}
          />
        </label>
      </div>

      <Totals summary={summary} />

      <h3 style={{ marginTop: '1.5rem' }}>
        Needs a decision ({attention.length})
      </h3>
      {attention.length === 0 ? (
        <p style={{ color: 'var(--good)' }}>Nothing left to look at — every line is matched, confirmed or explained.</p>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Reconciliation lines needing a decision"
          tabIndex={0}
          onKeyDown={onListKeyDown}
          style={{ outline: 'none' }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92em' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--line)' }}>
                <th style={th}>Document</th>
                <th style={th}>Ledger / sheet</th>
                <th style={{ ...th, textAlign: 'right' }}>Variance</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {attention.map((m, i) => (
                <tr
                  key={m.matchId}
                  role="option"
                  aria-selected={i === focusIndex}
                  onClick={() => setFocusIndex(i)}
                  style={{
                    borderBottom: '1px solid var(--line)',
                    background:
                      i === focusIndex ? 'var(--focus-bg)' : m.status === 'near_match' ? 'var(--attention-bg)' : undefined,
                    opacity: pendingId === m.matchId ? 0.6 : 1,
                  }}
                >
                  <td style={td}><LineCell line={m.documentLine} /></td>
                  <td style={td}><LineCell line={m.ledgerLine} /></td>
                  <td className="num" style={td}>
                    {m.amountVariance ? (
                      <span style={{ color: 'var(--bad)', fontWeight: 600 }}>{formatMoney(m.amountVariance)}</span>
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                      {m.status === 'near_match' && (
                        <>
                          <button type="button" disabled={!actor.trim()} onClick={() => act(m.matchId, { type: 'confirm' })}>
                            Confirm
                          </button>
                          <button type="button" disabled={!actor.trim()} onClick={() => act(m.matchId, { type: 'reject' })}>
                            Reject
                          </button>
                        </>
                      )}
                      {m.status === 'unmatched' && (
                        <button type="button" disabled={!actor.trim()} onClick={() => setNoteOpenFor(m.matchId)}>
                          Mark expected-missing
                        </button>
                      )}
                    </div>
                    {noteOpenFor === m.matchId && (
                      <div style={{ marginTop: '0.4rem', display: 'flex', gap: '0.4rem' }}>
                        <input
                          value={noteDraft[m.matchId] ?? ''}
                          onChange={(e) => setNoteDraft((d) => ({ ...d, [m.matchId]: e.target.value }))}
                          placeholder="Why is this expected to have no counterpart?"
                          style={{ flex: 1, padding: '0.15rem 0.4rem' }}
                        />
                        <button
                          type="button"
                          disabled={!(noteDraft[m.matchId] ?? '').trim() || !actor.trim()}
                          onClick={() => act(m.matchId, { type: 'expected_missing', note: (noteDraft[m.matchId] ?? '').trim() })}
                        >
                          Save
                        </button>
                        <button type="button" onClick={() => setNoteOpenFor(null)}>Cancel</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ marginTop: '1.5rem' }}>
        <button
          type="button"
          onClick={() => setShowMatched((v) => !v)}
          style={{ background: 'none', border: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: 0 }}
        >
          {showMatched ? '▾' : '▸'} Matched ({resolved.length}) — collapsed by default
        </button>
      </h3>
      {showMatched && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88em' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--line)' }}>
              <th style={th}>Document</th>
              <th style={th}>Ledger / sheet</th>
              <th style={th}>Status</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {resolved.map((m) => (
              <tr key={m.matchId} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={td}><LineCell line={m.documentLine} /></td>
                <td style={td}><LineCell line={m.ledgerLine} /></td>
                <td style={td}>
                  {m.status === 'confirmed' ? (
                    <span style={{ color: 'var(--good)' }}>Confirmed by {m.decidedBy}</span>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>Auto-matched (unambiguous)</span>
                  )}
                </td>
                <td style={td}>
                  <button type="button" disabled={!actor.trim()} onClick={() => act(m.matchId, { type: 'reject' })}>
                    Reject
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {decided.length > 0 && (
        <>
          <h3 style={{ marginTop: '1.5rem' }}>Resolved ({decided.length})</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88em' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--line)' }}>
                <th style={th}>Line</th>
                <th style={th}>Status</th>
                <th style={th}>Note</th>
                <th style={th}>By</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((m) => (
                <tr key={m.matchId} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={td}><LineCell line={m.documentLine ?? m.ledgerLine} /></td>
                  <td style={td}>{m.status === 'rejected' ? 'Rejected match' : 'Expected missing'}</td>
                  <td style={{ ...td, color: 'var(--muted)' }}>{m.note ?? '—'}</td>
                  <td style={{ ...td, color: 'var(--muted)' }}>{m.decidedBy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '0.4rem', color: 'var(--muted)', fontWeight: 600 };
const td: React.CSSProperties = { padding: '0.4rem', verticalAlign: 'top' };
