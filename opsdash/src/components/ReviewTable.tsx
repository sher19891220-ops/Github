'use client';

import { useEffect, useMemo, useState } from 'react';
import type { StagingRow } from '@/contract/types';
import { commitDocument, getReferenceData, getStagingRows, patchStagingRow } from './data/api';
import { errorMessageFor } from './data/fetchState';
import type { CommitResult, ReferenceData, StagingRowEdit } from './data/types';
import { formatMoney, formatQuantity } from './format/decimal';
import { blockedReason, formatParsedValue, isBlocked, summarizeCommit, wasEdited } from './review/logic';
import { StatusPill } from './StatusPill';

function optionLabel(options: { id: string; label: string }[], id: string | null): string {
  if (id == null) return '(none)';
  return options.find((o) => o.id === id)?.label ?? id;
}

function rowStatusPill(row: StagingRow) {
  switch (row.status) {
    case 'committed':
      return <StatusPill label="Committed" tone="good" />;
    case 'rejected':
      return <StatusPill label="Excluded" tone="muted" />;
    case 'under_review':
      return <StatusPill label="Edited" tone="warn" />;
    case 'parsed':
      return <StatusPill label="Parsed" tone="muted" />;
  }
}

/**
 * The review queue for a single document. Every field is editable; every
 * edit writes `reviewedPayload` (via `applyEdit` in `review/logic.ts`) and
 * leaves `parsedPayload` — what the machine actually read — untouched and
 * visible right next to it. Rows missing a required field explain why they
 * are blocked and cannot be committed; the commit banner tells the operator
 * exactly what pressing the button will do before they press it.
 */
export function ReviewTable({ documentId }: { documentId: string }) {
  // 'loading' / 'error' are distinct from a successful load that happens to
  // return zero rows — a document that parsed with nothing to review must
  // never look the same as one this screen could not fetch at all.
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [rows, setRows] = useState<StagingRow[]>([]);
  const [reference, setReference] = useState<ReferenceData | null>(null);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [commitState, setCommitState] = useState<
    { phase: 'idle' } | { phase: 'committing' } | { phase: 'done'; result: CommitResult } | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    Promise.all([getStagingRows(documentId), getReferenceData()])
      .then(([r, ref]) => {
        if (cancelled) return;
        setRows(r);
        setReference(ref);
        setLoadState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errorMessageFor(err, 'Could not load this document for review.'));
        setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, reloadKey]);

  const summary = useMemo(() => summarizeCommit(rows), [rows]);

  async function saveEdit(rowId: string, edit: Partial<StagingRowEdit>) {
    setSavingRowId(rowId);
    try {
      const updated = await patchStagingRow(rowId, edit);
      if (!updated) {
        setRowErrors((prev) => ({ ...prev, [rowId]: 'This row could not be found on the server — it may have been removed.' }));
        return;
      }
      setRows((prev) => prev.map((r) => (r.stagingRowId === rowId ? updated : r)));
      setRowErrors((prev) => {
        if (!(rowId in prev)) return prev;
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [rowId]: errorMessageFor(err, 'Could not save this edit.') }));
    } finally {
      setSavingRowId(null);
    }
  }

  async function handleCommit() {
    // Guard against a double-press client-side; the server index makes it
    // safe regardless, but there's no reason to fire the request twice.
    if (commitState.phase === 'committing') return;
    setCommitState({ phase: 'committing' });
    try {
      const result = await commitDocument(documentId);
      setCommitState({ phase: 'done', result });
      setRows((prev) =>
        prev.map((r) => (r.status === 'rejected' || r.status === 'committed' ? r : { ...r, status: 'committed' as const })),
      );
    } catch (err) {
      // The commit route is transactional: any failure here means nothing
      // was written to the ledger, not "some rows might have posted". Say
      // that plainly rather than leaving the operator unsure whether to
      // press Commit again.
      const detail = errorMessageFor(err, 'Commit failed.');
      setCommitState({
        phase: 'error',
        message: `${detail} Nothing was committed — commit is all-or-nothing, so it is safe to press Commit again.`,
      });
    }
  }

  if (loadState === 'loading') {
    return <p style={{ color: 'var(--muted)' }}>Loading staging rows…</p>;
  }

  if (loadState === 'error' || reference === null) {
    return (
      <div role="alert" style={{ color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 8, padding: '0.75rem' }}>
        <p style={{ margin: 0, fontWeight: 600 }}>Could not load this document for review</p>
        <p style={{ margin: '0.25rem 0 0' }}>{loadError ?? 'Unknown error.'}</p>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} style={{ marginTop: '0.5rem' }}>
          Retry
        </button>
      </div>
    );
  }

  const alreadyCommitted = commitState.phase === 'done' || summary.alreadyCommitted > 0;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          padding: '0.75rem',
          marginBottom: '0.75rem',
          border: '1px solid var(--line)',
          borderRadius: 8,
        }}
      >
        <div>
          <strong className="num" style={{ color: 'var(--good)' }}>{summary.willCommit}</strong> will commit
        </div>
        <div>
          <strong className="num" style={{ color: summary.blocked > 0 ? 'var(--bad)' : 'var(--muted)' }}>
            {summary.blocked}
          </strong>{' '}
          blocked
        </div>
        <div>
          <strong className="num" style={{ color: 'var(--muted)' }}>{summary.excluded}</strong> excluded
        </div>
        <div>
          <strong className="num" style={{ color: 'var(--muted)' }}>{summary.alreadyCommitted}</strong> already committed
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            disabled={!summary.canCommit || commitState.phase === 'committing' || alreadyCommitted}
            onClick={handleCommit}
            title={
              summary.blocked > 0
                ? 'Resolve every blocked row before committing.'
                : alreadyCommitted
                  ? 'This document has already been committed.'
                  : undefined
            }
          >
            {commitState.phase === 'committing'
              ? 'Committing…'
              : alreadyCommitted
                ? 'Committed'
                : `Commit ${summary.willCommit} row${summary.willCommit === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      {summary.blocked > 0 && (
        <p style={{ color: 'var(--bad)' }}>
          Commit is disabled: {summary.blocked} row{summary.blocked === 1 ? '' : 's'} still missing a
          required field. Fix or exclude every blocked row to enable commit.
        </p>
      )}
      {commitState.phase === 'done' && (
        <p role="status" style={{ color: 'var(--good)' }}>
          Committed {commitState.result.committed} row{commitState.result.committed === 1 ? '' : 's'}
          {commitState.result.rejected > 0 ? `, excluded ${commitState.result.rejected}` : ''}.
          {commitState.result.entryIds.length > 0 && (
            <> Ledger entries: {commitState.result.entryIds.join(', ')}.</>
          )}
        </p>
      )}
      {commitState.phase === 'error' && (
        <p role="alert" style={{ color: 'var(--bad)' }}>{commitState.message}</p>
      )}

      {/* The table is wide and the payload column is unpredictable; its
          own scroller keeps a long row from moving the page. */}
      <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92em' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--line)' }}>
            <th style={th}>#</th>
            <th style={th}>Status</th>
            <th style={th}>Entity</th>
            <th style={th}>Truck</th>
            <th style={th}>Driver</th>
            <th style={th}>Date</th>
            <th style={th}>Category</th>
            <th style={{ ...th, textAlign: 'right' }}>Amount</th>
            <th style={{ ...th, textAlign: 'right' }}>Qty</th>
            <th style={th}>Jur.</th>
            <th style={th}>Machine read (parsed)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const blocked = isBlocked(row);
            const reason = blockedReason(row);
            const locked = row.status === 'committed' || row.status === 'rejected';
            return (
              <tr
                key={row.stagingRowId}
                style={{
                  borderBottom: '1px solid var(--line)',
                  background: blocked ? 'color-mix(in srgb, var(--bad) 6%, transparent)' : undefined,
                  opacity: savingRowId === row.stagingRowId ? 0.6 : 1,
                }}
              >
                <td style={td}>{row.rowIndex}</td>
                <td style={td}>
                  {rowStatusPill(row)}
                  {blocked && (
                    <div style={{ color: 'var(--bad)', fontSize: '0.9em', marginTop: '0.2rem' }}>{reason}</div>
                  )}
                  {rowErrors[row.stagingRowId] && (
                    <div role="alert" style={{ color: 'var(--bad)', fontSize: '0.9em', marginTop: '0.2rem' }}>
                      {rowErrors[row.stagingRowId]}
                    </div>
                  )}
                </td>
                <td style={td}>
                  <EditableSelect
                    value={row.entityId}
                    options={reference.entities}
                    disabled={locked}
                    onChange={(v) => saveEdit(row.stagingRowId, { entityId: v })}
                    edited={wasEdited(row, 'entityId')}
                    missing={row.entityId == null}
                  />
                </td>
                <td style={td}>
                  <EditableSelect
                    value={row.truckId}
                    options={reference.trucks}
                    disabled={locked}
                    onChange={(v) => saveEdit(row.stagingRowId, { truckId: v })}
                    edited={wasEdited(row, 'truckId')}
                  />
                </td>
                <td style={td}>
                  <EditableSelect
                    value={row.driverId}
                    options={reference.drivers}
                    disabled={locked}
                    onChange={(v) => saveEdit(row.stagingRowId, { driverId: v })}
                    edited={wasEdited(row, 'driverId')}
                  />
                </td>
                <td style={td}>
                  <EditableText
                    value={row.accrualDate ?? ''}
                    type="date"
                    disabled={locked}
                    onCommit={(v) => saveEdit(row.stagingRowId, { accrualDate: v || null })}
                    edited={wasEdited(row, 'accrualDate')}
                    missing={row.accrualDate == null}
                  />
                </td>
                <td style={td}>
                  <EditableSelect
                    value={row.categoryId}
                    options={reference.categories}
                    disabled={locked}
                    onChange={(v) => saveEdit(row.stagingRowId, { categoryId: v })}
                    edited={wasEdited(row, 'categoryId')}
                    missing={row.categoryId == null}
                  />
                </td>
                <td className="num" style={td}>
                  <EditableText
                    value={row.amount ?? ''}
                    align="right"
                    disabled={locked}
                    onCommit={(v) => saveEdit(row.stagingRowId, { amount: v || null })}
                    edited={wasEdited(row, 'amount')}
                    missing={row.amount == null}
                    display={formatMoney(row.amount)}
                  />
                </td>
                <td className="num" style={td}>
                  <EditableText
                    value={row.quantity ?? ''}
                    align="right"
                    disabled={locked}
                    onCommit={(v) => saveEdit(row.stagingRowId, { quantity: v || null })}
                    edited={wasEdited(row, 'quantity')}
                    display={formatQuantity(row.quantity)}
                  />
                </td>
                <td style={td}>
                  <EditableText
                    value={row.jurisdiction ?? ''}
                    maxLength={2}
                    disabled={locked}
                    onCommit={(v) => saveEdit(row.stagingRowId, { jurisdiction: v ? v.toUpperCase() : null })}
                    edited={wasEdited(row, 'jurisdiction')}
                  />
                </td>
                <td style={{ ...td, color: 'var(--muted)', fontSize: '0.85em', maxWidth: 260 }}>
                  <ParsedSummary row={row} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/**
 * What the parser read, as one line.
 *
 * `overflowWrap: anywhere` is load-bearing. The real expenses export
 * produces payloads like `idRaw: has paid · dateRaw: 02.18.22 · unitRaw:
 * 225 · unitType: …` — a single unbroken 426px run that pushed the whole
 * review page 148px wider than the viewport, so every row scrolled
 * sideways. It only shows up on real data: the test fixtures' payloads
 * are short enough to fit.
 *
 * `display: block` with a max width, rather than letting the cell size
 * itself: a table cell will happily grow to fit its content and take the
 * table with it.
 */
function ParsedSummary({ row }: { row: StagingRow }) {
  const entries = Object.entries(row.parsedPayload);
  if (entries.length === 0) return <span>(no parsed fields)</span>;
  return (
    <span style={{ display: 'block', maxWidth: '32rem', overflowWrap: 'anywhere' }}>
      {entries.map(([k, v]) => `${k}: ${formatParsedValue(v)}`).join(' · ')}
    </span>
  );
}

function EditKeyframe({ edited, missing, children }: { edited: boolean; missing?: boolean; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: '100%',
        borderBottom: edited ? '2px solid var(--accent)' : missing ? '2px solid var(--bad)' : '2px solid transparent',
      }}
      title={edited ? 'Edited by a reviewer' : missing ? 'Required for commit' : undefined}
    >
      {children}
    </span>
  );
}

function EditableSelect({
  value,
  options,
  onChange,
  disabled,
  edited,
  missing,
}: {
  value: string | null;
  options: { id: string; label: string }[];
  onChange: (v: string | null) => void;
  disabled?: boolean;
  edited?: boolean;
  missing?: boolean;
}) {
  return (
    <EditKeyframe edited={!!edited} missing={missing}>
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        style={{ width: '100%', border: 'none', background: 'transparent', color: 'inherit' }}
      >
        <option value="">{missing ? '— select —' : '(none)'}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </EditKeyframe>
  );
}

function EditableText({
  value,
  onCommit,
  disabled,
  edited,
  missing,
  type = 'text',
  align,
  maxLength,
  display,
}: {
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  edited?: boolean;
  missing?: boolean;
  type?: 'text' | 'date';
  align?: 'right';
  maxLength?: number;
  /** When set, shown instead of the raw value while not focused (used for
   *  money/quantity columns so the resting state renders the formatted
   *  decimal string, never a value run through `Number()`). */
  display?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <EditKeyframe edited={!!edited} missing={missing}>
      <input
        type={type}
        value={focused || !display ? draft : display}
        disabled={disabled}
        maxLength={maxLength}
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          if (draft !== value) onCommit(draft);
        }}
        style={{
          width: '100%',
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          textAlign: align,
          font: 'inherit',
        }}
      />
    </EditKeyframe>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '0.4rem', color: 'var(--muted)', fontWeight: 600 };
const td: React.CSSProperties = { padding: '0.35rem 0.4rem', verticalAlign: 'top' };
