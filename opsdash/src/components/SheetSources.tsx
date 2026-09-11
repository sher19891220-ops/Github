'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SheetPurpose, SheetSourceRecord } from '@/db/repo/sheetSource';
import {
  getSheetSources,
  postRebaseline,
  postSheetSource,
  postSheetSync,
} from './data/api';
import { errorMessageFor, errored, loaded, loading, type FetchState } from './data/fetchState';

/**
 * The third intake path: sheets the operator already keeps.
 *
 * The screen is mostly about one thing — what happens when a sheet's
 * columns move. A sync that reads a changed sheet writes plausible, wrong
 * numbers, so the guard refuses rather than warns, and this is where a
 * person sees why and decides what to do about it.
 *
 * What it does not pretend: nothing here fetches from Google Drive. The
 * app has no Drive client, so the export is pasted or supplied by whatever
 * fetched it. Saying so on the screen is better than a "Sync" button that
 * would need a credential nobody has configured.
 */

const PURPOSES: { value: SheetPurpose; label: string; parsed: boolean }[] = [
  { value: 'revenue', label: 'Dispatch / revenue', parsed: true },
  { value: 'fuel', label: 'Fuel', parsed: true },
  { value: 'fuel_summary', label: 'Fuel summary', parsed: true },
  { value: 'maintenance_cost', label: 'Truck & trailer expenses', parsed: true },
  { value: 'maintenance_log', label: 'Maintenance log', parsed: true },
  { value: 'toll', label: 'Tolls', parsed: true },
  { value: 'ifta_mileage', label: 'IFTA mileage', parsed: true },
  { value: 'factoring', label: 'Factoring', parsed: true },
  { value: 'truck_status', label: 'Truck status', parsed: false },
  { value: 'truck_roster', label: 'Truck roster', parsed: false },
  { value: 'driver_roster', label: 'Driver roster', parsed: false },
  { value: 'driver_pay', label: 'Driver pay', parsed: false },
  { value: 'lease', label: 'Lease', parsed: false },
  { value: 'odometer', label: 'Odometer', parsed: false },
  { value: 'intercompany', label: 'Intercompany', parsed: false },
];

export function SheetSources() {
  const [state, setState] = useState<FetchState<SheetSourceRecord[]>>(loading());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState(loading());
    getSheetSources()
      .then((r) => {
        if (!cancelled) setState(loaded(r.sources));
      })
      .catch((err) => {
        if (!cancelled) setState(errored(errorMessageFor(err, 'Could not load the sheet registry.')));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <div>
      <p style={{ color: 'var(--muted)', maxWidth: '68ch' }}>
        Sheets the accounting team already keeps. A sheet is registered once and its column layout is recorded
        on the first sync; every sync after that is <strong>refused</strong> if the columns moved, because a
        sync that reads a changed sheet writes numbers that look right and are not.
      </p>
      <p style={{ color: 'var(--muted)', maxWidth: '68ch' }}>
        This app has no Google Drive client, so paste the sheet&rsquo;s export below rather than expecting a
        button to fetch it. That boundary is deliberate: deciding whether text is safe to ingest is separable
        from — and more important than — fetching it.
      </p>

      <RegisterSheet onDone={reload} />

      {state.status === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading the registry…</p>}

      {state.status === 'error' && (
        <div role="alert" style={{ color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 8, padding: '0.75rem' }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Could not load the sheet registry</p>
          <p style={{ margin: '0.25rem 0 0' }}>{state.message}</p>
          <button type="button" onClick={reload} style={{ marginTop: '0.5rem' }}>
            Retry
          </button>
        </div>
      )}

      {state.status === 'loaded' &&
        (state.data.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No sheets registered yet.</p>
        ) : (
          <div style={{ marginTop: '1.25rem' }}>
            {state.data.map((s) => (
              <SheetRow key={s.sheetSourceId} source={s} onDone={reload} />
            ))}
          </div>
        ))}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.2rem',
  fontSize: '0.8rem',
  color: 'var(--muted)',
  flex: '1 1 11rem',
  minWidth: 0,
};
const control: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box' };

function RegisterSheet({ onDone }: { onDone: () => void }) {
  const [driveFileId, setDriveFileId] = useState('');
  const [tabName, setTabName] = useState('');
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState<SheetPurpose>('maintenance_cost');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = driveFileId.trim() !== '' && title.trim() !== '';
  const selected = PURPOSES.find((p) => p.value === purpose);

  return (
    <details style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '0.75rem 0.9rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Register a sheet</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          postSheetSource({
            driveFileId: driveFileId.trim(),
            tabName: tabName.trim() === '' ? null : tabName.trim(),
            title: title.trim(),
            purpose,
          })
            .then(() => {
              setDriveFileId('');
              setTabName('');
              setTitle('');
              onDone();
            })
            .catch((err) => setError(errorMessageFor(err, 'Could not register the sheet.')))
            .finally(() => setBusy(false));
        }}
      >
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <label style={labelStyle}>
            Title
            <input style={control} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Truck and trailer expenses 2026" />
          </label>
          <label style={labelStyle}>
            Drive file id
            <input style={control} value={driveFileId} onChange={(e) => setDriveFileId(e.target.value)} />
          </label>
          <label style={labelStyle}>
            Tab (optional)
            <input style={control} value={tabName} onChange={(e) => setTabName(e.target.value)} />
          </label>
          <label style={labelStyle}>
            What it holds
            <select style={control} value={purpose} onChange={(e) => setPurpose(e.target.value as SheetPurpose)}>
              {PURPOSES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                  {p.parsed ? '' : ' — no parser yet'}
                </option>
              ))}
            </select>
          </label>
        </div>
        {selected?.parsed === false && (
          <p style={{ color: 'var(--warn)', fontSize: '0.85rem' }}>
            Nothing parses this kind of sheet yet, so it can be registered but not synced. Enter these by hand
            on <strong>Add a figure</strong> until a parser exists — better than a sync that writes nothing and
            looks like an empty sheet.
          </p>
        )}
        {error !== null && (
          <p role="alert" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={!ready || busy}>
          {busy ? 'Saving…' : 'Register'}
        </button>
      </form>
    </details>
  );
}

function SheetRow({ source, onDone }: { source: SheetSourceRecord; onDone: () => void }) {
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layoutChanged, setLayoutChanged] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [confirmedBy, setConfirmedBy] = useState('');

  const statusColor =
    source.lastSyncStatus === 'ok'
      ? 'var(--good)'
      : source.lastSyncStatus === 'layout_changed'
        ? 'var(--warn)'
        : source.lastSyncStatus === 'failed'
          ? 'var(--bad)'
          : 'var(--muted)';

  async function sync(): Promise<void> {
    setBusy(true);
    setError(null);
    setLayoutChanged(false);
    setResult(null);
    try {
      const r = await postSheetSync(source.sheetSourceId, rawText);
      setResult(
        r.duplicateOf !== null
          ? 'That is the same text as the last sync — nothing was re-read.'
          : `${r.rowsWritten} row${r.rowsWritten === 1 ? '' : 's'} staged${r.baselined ? '; layout recorded as the baseline' : ''}.`,
      );
      onDone();
    } catch (err) {
      const message = errorMessageFor(err, 'Could not sync this sheet.');
      setError(message);
      // The layout case gets its own affordance: this is the only error a
      // person can resolve by deciding the new shape is correct.
      setLayoutChanged(/columns changed|different order/i.test(message));
    } finally {
      setBusy(false);
    }
  }

  async function rebaseline(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await postRebaseline(source.sheetSourceId, rawText, confirmedBy.trim());
      setLayoutChanged(false);
      setResult('New layout accepted. Sync again to ingest it.');
      onDone();
    } catch (err) {
      setError(errorMessageFor(err, 'Could not accept the new layout.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '0.75rem 0.9rem', marginBottom: '0.75rem' }}>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong>{source.title}</strong>
        {source.tabName !== null && <span style={{ color: 'var(--muted)' }}>· {source.tabName}</span>}
        <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>{source.purpose}</span>
        <span style={{ color: statusColor, fontSize: '0.85rem' }}>
          {source.lastSyncStatus === 'layout_changed'
            ? '● columns moved'
            : source.lastSyncStatus === 'ok'
              ? '● last sync ok'
              : source.lastSyncStatus === 'failed'
                ? '● last sync failed'
                : '● never synced'}
        </span>
      </div>

      {source.lastSyncError !== null && (
        <p style={{ color: 'var(--warn)', fontSize: '0.85rem', margin: '0.4rem 0' }}>{source.lastSyncError}</p>
      )}

      {!source.syncable ? (
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: '0.4rem 0 0' }}>
          No parser reads this kind of sheet yet — registered, not syncable.
        </p>
      ) : (
        <details style={{ marginTop: '0.5rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.9rem' }}>Sync from an export</summary>
          <textarea
            style={{ ...control, minHeight: 110, fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem', marginTop: '0.5rem' }}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="Paste the sheet export, header row first."
          />
          {error !== null && (
            <div
              role="alert"
              style={{ color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 8, padding: '0.6rem', margin: '0.5rem 0' }}
            >
              <strong>Nothing was synced.</strong> {error}
            </div>
          )}
          {result !== null && <p style={{ color: 'var(--good)' }}>{result}</p>}

          {layoutChanged && (
            <div style={{ border: '1px solid var(--warn)', borderRadius: 8, padding: '0.6rem', marginBottom: '0.5rem' }}>
              <p style={{ margin: '0 0 0.4rem', fontSize: '0.85rem' }}>
                If the new layout is correct, accept it. Your name goes on the record, because a guard that can
                be stepped over silently is not a guard.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  style={{ ...control, flex: '1 1 12rem' }}
                  value={confirmedBy}
                  onChange={(e) => setConfirmedBy(e.target.value)}
                  placeholder="your name"
                />
                <button type="button" disabled={confirmedBy.trim() === '' || busy} onClick={() => void rebaseline()}>
                  Accept the new layout
                </button>
              </div>
            </div>
          )}

          <button type="button" disabled={rawText.trim() === '' || busy} onClick={() => void sync()}>
            {busy ? 'Syncing…' : 'Sync'}
          </button>
        </details>
      )}
    </div>
  );
}
