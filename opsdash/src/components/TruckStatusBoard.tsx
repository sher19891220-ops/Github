'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StatusSource, TruckStatus, TruckStatusNow } from '@/contract/types';
import { getReferenceData, getTruckStatus, postTruckStatus } from './data/api';
import { errorMessageFor, errored, loaded, loading, type FetchState } from './data/fetchState';
import type { ReferenceData } from './data/types';

/**
 * The fleet board's status panels, finally on a real source.
 *
 * `FLEET-BOARD-SPEC.md` §6 asked where status lives and, lacking an answer,
 * rendered these panels as *no data* rather than inferring them from
 * dispatch lane text. That restraint was right — 28 cells carrying `SHOP`,
 * `HOME` or `OOS` also carry real revenue, measured — and it is now
 * unnecessary: status comes from Samsara, Motive, a sheet, or a person
 * marking it here.
 *
 * The load-bearing rendering decision: **`unknown` is a status class on
 * this board, shown as prominently as the rest.** A truck nobody has
 * marked is not available; a board that quietly files it under `open`
 * invents fleet capacity, and capacity is the number this board exists to
 * report.
 *
 * Colour follows the reserved status palette and always ships as chip plus
 * label, never colour alone — two of these sit below 3:1 on the light
 * surface by design and the label is the mitigation.
 */

const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned',
  open: 'Open',
  shop: 'In shop',
  broken_down: 'Broken down',
  home: 'Home',
  out_of_service: 'Out of service',
  unknown: 'No status on file',
};

/**
 * Seven classes is at the edge of what colour can carry, so every chip
 * ships with its label and the colour is the secondary cue — a
 * colour-blind reader, a printed copy and a forced-colours display all
 * still read this board.
 *
 * Even so, no two classes share a value. A first pass had shop and home
 * both on --warn and broken-down and out-of-service both on --bad, which
 * makes four states look like two at a glance; the fleet board spec
 * assigned them distinct colours for exactly that reason.
 */
const STATUS_COLOR: Record<string, string> = {
  assigned: 'var(--good)',
  open: 'var(--accent)',
  shop: 'var(--status-shop)',
  home: 'var(--warn)',
  broken_down: 'var(--bad)',
  out_of_service: 'var(--status-oos)',
  unknown: 'var(--muted)',
};

const MARKABLE: TruckStatus[] = ['assigned', 'open', 'shop', 'broken_down', 'home', 'out_of_service'];

function Chip({ status }: { status: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}>
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: STATUS_COLOR[status] ?? 'var(--muted)',
          flexShrink: 0,
        }}
      />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** Hours, as somebody says them. The board's "Ready 24+" and "Home 48+"
 *  are these numbers, measured rather than guessed. */
function since(hours: number): string {
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function TruckStatusBoard() {
  const [state, setState] = useState<FetchState<{ statuses: TruckStatusNow[]; counts: Record<string, number> }>>(
    loading(),
  );
  const [reference, setReference] = useState<ReferenceData | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState(loading());
    Promise.all([getTruckStatus(), getReferenceData().catch(() => null)])
      .then(([s, r]) => {
        if (cancelled) return;
        setState(loaded(s));
        setReference(r);
      })
      .catch((err) => {
        if (!cancelled) setState(errored(errorMessageFor(err, 'Could not load truck status.')));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const truckLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of reference?.trucks ?? []) m.set(t.id, t.label);
    return m;
  }, [reference]);

  if (state.status === 'loading') return <p style={{ color: 'var(--muted)' }}>Loading truck status…</p>;

  if (state.status === 'error') {
    return (
      <div role="alert" style={{ color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 8, padding: '0.75rem' }}>
        <p style={{ margin: 0, fontWeight: 600 }}>Could not load truck status</p>
        <p style={{ margin: '0.25rem 0 0' }}>{state.message}</p>
        <button type="button" onClick={reload} style={{ marginTop: '0.5rem' }}>
          Retry
        </button>
      </div>
    );
  }

  const { statuses, counts } = state.data;
  const classes = [...MARKABLE.map(String), 'unknown'];

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {classes.map((c) => (
          <div
            key={c}
            style={{
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: '0.6rem 0.8rem',
              flex: '1 1 140px',
              minWidth: 0,
            }}
          >
            <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>
              <Chip status={c} />
            </div>
            <div style={{ fontSize: '1.4rem', fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>
              {counts[c] ?? 0}
            </div>
          </div>
        ))}
      </div>

      {(counts.unknown ?? 0) > 0 && (
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          {counts.unknown} active truck{counts.unknown === 1 ? ' has' : 's have'} no status on file. That is not
          the same as being available, so {counts.unknown === 1 ? 'it is' : 'they are'} counted separately rather
          than as open capacity.
        </p>
      )}

      <MarkStatus trucks={reference?.trucks ?? []} onDone={reload} />

      <h2 style={{ fontSize: '1rem', margin: '1.5rem 0 0.5rem' }}>Current status</h2>
      {statuses.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>
          No truck has a status yet. Mark one above, or connect Samsara or Motive.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: '0.8rem' }}>
                <th style={{ padding: '0.35rem 0' }}>Truck</th>
                <th style={{ padding: '0.35rem 0' }}>Status</th>
                <th style={{ padding: '0.35rem 0' }}>For</th>
                <th style={{ padding: '0.35rem 0' }}>From</th>
                <th style={{ padding: '0.35rem 0' }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {statuses.map((s) => (
                <tr key={s.truckId} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '0.4rem 0.5rem 0.4rem 0' }}>
                    {truckLabel.get(s.truckId) ?? s.truckId}
                  </td>
                  <td style={{ padding: '0.4rem 0.5rem 0.4rem 0' }}>
                    <Chip status={s.status} />
                  </td>
                  <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', fontVariantNumeric: 'tabular-nums' }}>
                    {since(s.hoursInStatus)}
                  </td>
                  <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', color: 'var(--muted)', fontSize: '0.85rem' }}>
                    {s.source}
                  </td>
                  <td style={{ padding: '0.4rem 0', color: 'var(--muted)', fontSize: '0.85rem' }}>
                    {s.note ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MarkStatus({
  trucks,
  onDone,
}: {
  trucks: readonly { id: string; label: string }[];
  onDone: () => void;
}) {
  const [truckId, setTruckId] = useState('');
  const [status, setStatus] = useState<TruckStatus>('shop');
  const [assertedBy, setAssertedBy] = useState('');
  const [basis, setBasis] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const ready = truckId !== '' && assertedBy.trim() !== '' && basis.trim() !== '';

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await postTruckStatus({
        truckId,
        status,
        source: 'manual' as StatusSource,
        assertedBy: assertedBy.trim(),
        basis: basis.trim(),
        note: note.trim() === '' ? null : note.trim(),
      });
      setDone(r.previous === null ? `Marked ${r.current}.` : `${r.previous} → ${r.current}.`);
      setNote('');
      onDone();
    } catch (err) {
      setError(errorMessageFor(err, 'Could not set the status.'));
    } finally {
      setBusy(false);
    }
  }

  const label: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
    fontSize: '0.8rem',
    color: 'var(--muted)',
    flex: '1 1 10rem',
    minWidth: 0,
  };
  const control: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box' };

  return (
    <details style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '0.75rem 0.9rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Mark a truck&rsquo;s status</summary>
      <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
        Marking a new status ends the previous one — a truck is in one state at a time. Recorded as your word,
        the same as a typed figure, so the board can show which statuses came from telematics and which from a
        person.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <label style={label}>
            Truck
            <select style={control} value={truckId} onChange={(e) => setTruckId(e.target.value)}>
              <option value="">Choose…</option>
              {trucks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            Status
            <select style={control} value={status} onChange={(e) => setStatus(e.target.value as TruckStatus)}>
              {MARKABLE.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            Your name
            <input style={control} value={assertedBy} onChange={(e) => setAssertedBy(e.target.value)} />
          </label>
          <label style={{ ...label, flex: '2 1 16rem' }}>
            How do you know?
            <input
              style={control}
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
              placeholder="Driver called in; shop confirmed."
            />
          </label>
          <label style={{ ...label, flex: '2 1 16rem' }}>
            Note (optional)
            <input style={control} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        {error !== null && (
          <p role="alert" style={{ color: 'var(--bad)' }}>
            <strong>Nothing changed.</strong> {error}
          </p>
        )}
        {done !== null && <p style={{ color: 'var(--good)' }}>{done}</p>}
        <button type="submit" disabled={!ready || busy}>
          {busy ? 'Saving…' : 'Mark status'}
        </button>
        {!ready && (
          <span style={{ color: 'var(--muted)', fontSize: '0.85rem', marginLeft: '0.75rem' }}>
            Pick a truck, put your name on it, and say how you know.
          </span>
        )}
      </form>
    </details>
  );
}
