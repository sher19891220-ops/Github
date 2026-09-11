'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import type { IftaReturnView } from '@/db/repo/ifta';
import type { IftaJurisdictionLine } from '@/engines/ifta';
import {
  getIftaRates,
  getIftaReturn,
  getReferenceData,
  postIftaRate,
  saveIftaReturn,
} from './data/api';
import { errorMessageFor, errored, loaded, loading, type FetchState } from './data/fetchState';
import type { IftaRatesResponse, ReferenceData } from './data/types';
import { formatDecimalString, formatMoney, formatQuantity } from './format/decimal';
import {
  includedDocumentCount,
  lineDirection,
  netDueReading,
  periodPresets,
  quarterLabel,
  saveBlockReason,
  withheldJurisdictions,
} from './ifta/logic';

/**
 * The IFTA screen — accounting's and safety's view of the same arithmetic.
 *
 * Form decisions, from the visualisation guidance rather than taste:
 *
 *  - **Four stat tiles, not a chart.** Miles, gallons, fleet MPG and the
 *    net figure are four single values. A chart of four numbers renders
 *    each less precisely than type does.
 *  - **The jurisdictions are a table.** A map of states shaded by tax owed
 *    would be a choropleth of a quantity that is not per-area, and the
 *    numbers are what gets typed into a filing.
 *  - **Base tax and surcharge get separate columns, always, even when
 *    every surcharge is zero.** Collapsing them into one number is the
 *    exact error the engine exists to refuse, and a column that appears
 *    only when it is non-zero teaches a reader it is an exception rather
 *    than a permanent part of the return.
 *  - **Owed and credit never share a wording.** A minus sign in front of
 *    money in a table of tax is too easy to read past.
 *
 * The two bands above the table carry the weight. `blocked` means the
 * engine refused and there is no figure at all; `sourceProblems` name what
 * a person could upload or type to change that. They are separate because
 * only one of them is actionable.
 */

const label: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.85rem',
  color: 'var(--muted)',
  minWidth: 0,
  flex: '1 1 10rem',
};
const control: CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box' };
/**
 * Horizontal padding on every cell is load-bearing, not decoration: a
 * right-aligned numeric column sits flush against the left-aligned column
 * after it, and "5" beside "yes" renders as "5yes". The outer edges are
 * trimmed by `firstCol`/`lastCol` so the table still lines up with the
 * text above it.
 */
const cell: CSSProperties = {
  padding: '0.4rem 0.6rem',
  textAlign: 'right',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
};
const headCell: CSSProperties = { padding: '0.35rem 0.6rem', textAlign: 'right', fontWeight: 600 };
const textCell: CSSProperties = { padding: '0.4rem 0.6rem', textAlign: 'left' };
const textHead: CSSProperties = { padding: '0.35rem 0.6rem', textAlign: 'left', fontWeight: 600 };
const firstCol: CSSProperties = { paddingLeft: 0 };
const lastCol: CSSProperties = { paddingRight: 0 };

export function IftaView() {
  const presets = useMemo(() => periodPresets(new Date()), []);
  const firstPreset = presets[0]!;
  const [presetId, setPresetId] = useState(firstPreset.id);
  const [from, setFrom] = useState(firstPreset.from);
  const [to, setTo] = useState(firstPreset.to);
  const [entityId, setEntityId] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [state, setState] = useState<FetchState<IftaReturnView>>(loading());
  const [reference, setReference] = useState<ReferenceData | null>(null);

  useEffect(() => {
    let cancelled = false;
    getReferenceData()
      .then((r) => !cancelled && setReference(r))
      .catch(() => !cancelled && setReference(null));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState(loading());
    getIftaReturn({ from, to, ...(entityId !== '' ? { entityId } : {}) })
      .then((v) => !cancelled && setState(loaded(v)))
      .catch((err) => !cancelled && setState(errored(errorMessageFor(err, 'Could not compute the IFTA figure.'))));
    return () => {
      cancelled = true;
    };
  }, [from, to, entityId, reloadKey]);

  const applyPreset = useCallback(
    (id: string) => {
      const p = presets.find((x) => x.id === id);
      setPresetId(id);
      if (p) {
        setFrom(p.from);
        setTo(p.to);
      }
    },
    [presets],
  );

  const view = state.status === 'loaded' ? state.data : null;

  return (
    <div>
      <p style={{ color: 'var(--muted)', margin: '0 0 1rem', maxWidth: '54rem' }}>
        Miles by state come from the IFTA mileage reports on the{' '}
        <Link href="/documents" style={{ color: 'var(--accent)' }}>
          Documents
        </Link>{' '}
        screen. Gallons come from posted fuel purchases, credited to the state they were
        <em> bought</em> in. Rates are typed in below — no document supplies them.
      </p>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem 1rem',
          marginBottom: '1.25rem',
          alignItems: 'flex-end',
        }}
      >
        <label style={label}>
          Period
          <select style={control} value={presetId} onChange={(e) => applyPreset(e.target.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>
        <label style={label}>
          From
          <input
            type="date"
            style={control}
            value={from}
            onChange={(e) => {
              setPresetId('custom');
              setFrom(e.target.value);
            }}
          />
        </label>
        <label style={label}>
          To
          <input
            type="date"
            style={control}
            value={to}
            onChange={(e) => {
              setPresetId('custom');
              setTo(e.target.value);
            }}
          />
        </label>
        <label style={label}>
          Licensee
          <select style={control} value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">All (view only — a return is filed by one licensee)</option>
            {(reference?.entities ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.status === 'loading' && <p style={{ color: 'var(--muted)' }}>Computing…</p>}
      {state.status === 'error' && (
        <p
          style={{
            color: 'var(--bad)',
            border: '1px solid var(--bad)',
            borderRadius: 6,
            padding: '0.75rem',
          }}
        >
          {state.message}
        </p>
      )}

      {view !== null && (
        <>
          <PeriodBanner view={view} />
          {view.blocked !== null && <BlockedBand message={view.blocked} />}
          {view.result !== null && <Tiles view={view} />}
          <SourceProblems view={view} />
          {view.result !== null && <EngineProblems problems={view.result.problems} />}
          {view.result !== null && <JurisdictionTable lines={view.result.lines} />}
          <Sources view={view} />
          <SaveReturn view={view} onSaved={() => setReloadKey((k) => k + 1)} />
        </>
      )}

      <RatePanel
        view={view}
        onRateAdded={() => setReloadKey((k) => k + 1)}
      />
    </div>
  );
}

/* --------------------------------------------------------------------- */

/**
 * Says in one line whether this is a filing or an estimate, before any
 * number appears. The operator asked for daily and weekly figures; the
 * arithmetic is identical and only one of the two can be sent to a state,
 * so the distinction goes above the numbers rather than in a footnote.
 */
function PeriodBanner({ view }: { view: IftaReturnView }) {
  const isQuarter = view.periodKind === 'quarter';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '0.6rem',
        flexWrap: 'wrap',
        marginBottom: '0.85rem',
      }}
    >
      <span
        style={{
          fontWeight: 700,
          fontSize: '0.8rem',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: isQuarter ? 'var(--good)' : 'var(--warn)',
          border: `1px solid ${isQuarter ? 'var(--good)' : 'var(--warn)'}`,
          borderRadius: 4,
          padding: '0.1rem 0.4rem',
        }}
      >
        {isQuarter ? 'Return' : 'Accrual'}
      </span>
      <span style={{ color: 'var(--muted)' }}>
        {view.from} to {view.to} · rates for {quarterLabel(view)} ·{' '}
        {isQuarter
          ? 'a calendar quarter, so this can be filed'
          : 'not a calendar quarter — this is what is building up, not a return'}
      </span>
    </div>
  );
}

function BlockedBand({ message }: { message: string }) {
  return (
    <div
      style={{
        border: '1px solid var(--warn)',
        background: 'var(--attention-bg)',
        borderRadius: 6,
        padding: '0.85rem',
        marginBottom: '1.25rem',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>No figure for this period</div>
      <div style={{ color: 'var(--muted)' }}>{message}</div>
    </div>
  );
}

function Tiles({ view }: { view: IftaReturnView }) {
  const r = view.result!;
  const net = netDueReading(r.netDue);
  const tone =
    net.direction === 'owed' ? 'var(--bad)' : net.direction === 'credit' ? 'var(--good)' : 'var(--fg)';

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.25rem' }}>
      <Tile label="Total miles" value={formatQuantity(r.totalMiles)} />
      <Tile label="Gallons purchased" value={formatQuantity(r.totalGallonsPurchased)} />
      <Tile
        label="Fleet MPG"
        value={formatDecimalString(r.fleetMpg)}
        note="Fleet-wide, never per state"
      />
      <Tile label={net.label} value={formatMoney(net.amount)} tone={tone} />
    </div>
  );
}

function Tile({
  label: text,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: string;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '0.75rem 0.9rem',
        flex: '1 1 10rem',
        minWidth: 0,
      }}
    >
      <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{text}</div>
      {/* A number must never break across lines. `overflowWrap: anywhere`
          — correct for filenames and prose elsewhere on this screen — turned
          "9,510.7500" into "9,510.750" over "0" at phone width, which reads
          as two numbers. So: nowrap, a font size that shrinks with the
          viewport, and a scroll inside the tile as the last resort. The
          figure is never broken, never rounded, and never clipped. */}
      <div
        style={{
          fontSize: 'clamp(1.05rem, 4vw, 1.45rem)',
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          overflowX: 'auto',
          color: tone ?? 'var(--fg)',
        }}
      >
        {value}
      </div>
      {note !== undefined && (
        <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>{note}</div>
      )}
    </div>
  );
}

/** Problems about the inputs — every one of these is something a person
 *  can fix by uploading or typing something. Kept apart from the engine's
 *  problems, which are about the return itself. */
function SourceProblems({ view }: { view: IftaReturnView }) {
  if (view.sourceProblems.length === 0) return null;
  return (
    <details open style={{ marginBottom: '1rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
        What is missing from the inputs ({view.sourceProblems.length})
      </summary>
      <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem', color: 'var(--muted)' }}>
        {view.sourceProblems.map((p) => (
          <li key={p} style={{ marginBottom: '0.35rem', overflowWrap: 'anywhere' }}>
            {p}
          </li>
        ))}
      </ul>
    </details>
  );
}

function EngineProblems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) return null;
  return (
    <details open style={{ marginBottom: '1.25rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
        What makes this less than a filing ({problems.length})
      </summary>
      <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem', color: 'var(--muted)' }}>
        {problems.map((p) => (
          <li key={p} style={{ marginBottom: '0.35rem', overflowWrap: 'anywhere' }}>
            {p}
          </li>
        ))}
      </ul>
    </details>
  );
}

function JurisdictionTable({ lines }: { lines: readonly IftaJurisdictionLine[] }) {
  if (lines.length === 0) {
    return (
      <p style={{ color: 'var(--muted)' }}>
        No jurisdiction has both miles and a rate on file, so there are no lines to show.
      </p>
    );
  }

  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>By jurisdiction</h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead>
            <tr style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
              <th style={{ ...textHead, ...firstCol }}>State</th>
              <th style={headCell}>Taxable miles</th>
              <th style={headCell}>Taxable gal</th>
              <th style={headCell}>Tax-paid gal</th>
              <th style={headCell}>Net gal</th>
              <th style={headCell}>Rate</th>
              <th style={headCell}>Base tax</th>
              <th style={headCell}>Surcharge</th>
              <th style={{ ...headCell, ...lastCol }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const dir = lineDirection(l);
              return (
                <tr key={l.jurisdiction} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ ...textCell, ...firstCol, fontWeight: 600 }}>{l.jurisdiction}</td>
                  <td style={cell}>{formatQuantity(l.taxableMiles)}</td>
                  <td style={cell}>{formatQuantity(l.taxableGallons)}</td>
                  <td style={cell}>{formatQuantity(l.taxPaidGallons)}</td>
                  <td style={cell}>{formatQuantity(l.netTaxableGallons)}</td>
                  <td style={cell}>{formatDecimalString(l.ratePerGallon)}</td>
                  <td style={cell}>{formatMoney(l.taxDue)}</td>
                  {/* Always shown, never conditional: a surcharge column
                      that appears only when non-zero reads as an exception
                      rather than a permanent part of the return. */}
                  <td style={{ ...cell, color: l.surchargeDue === '0.00' ? 'var(--muted)' : 'var(--fg)' }}>
                    {formatMoney(l.surchargeDue)}
                  </td>
                  <td
                    style={{
                      ...cell,
                      ...lastCol,
                      fontWeight: 700,
                      color: dir === 'owed' ? 'var(--bad)' : dir === 'credit' ? 'var(--good)' : 'var(--fg)',
                    }}
                  >
                    {formatMoney(l.totalDue)}
                    <div style={{ fontSize: '0.7rem', fontWeight: 500, color: 'var(--muted)' }}>
                      {dir === 'owed' ? 'owed' : dir === 'credit' ? 'credit' : '—'}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
        Surcharge is charged on taxable gallons with no credit for tax paid at the pump, so it is never
        netted and never a credit. Base tax is on net gallons and can be.
      </p>
    </section>
  );
}

/** What actually fed this figure. "Traced to a source document" is a claim
 *  until the documents are named. */
function Sources({ view }: { view: IftaReturnView }) {
  const included = includedDocumentCount(view);
  return (
    <details style={{ marginBottom: '1.25rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
        Where these numbers came from ({included} mileage report{included === 1 ? '' : 's'},{' '}
        {view.sources.fuelEntryCount} fuel state{view.sources.fuelEntryCount === 1 ? '' : 's'},{' '}
        {view.sources.rateCount} rate{view.sources.rateCount === 1 ? '' : 's'})
      </summary>
      <div style={{ marginTop: '0.5rem', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
          <thead>
            <tr style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
              <th style={{ ...textHead, ...firstCol }}>Mileage report</th>
              <th style={textHead}>Period</th>
              <th style={headCell}>Rows</th>
              <th style={{ ...textHead, ...lastCol }}>Used</th>
            </tr>
          </thead>
          <tbody>
            {view.sources.mileageDocuments.length === 0 && (
              <tr>
                <td colSpan={4} style={{ ...textCell, ...firstCol, color: 'var(--muted)' }}>
                  None.
                </td>
              </tr>
            )}
            {view.sources.mileageDocuments.map((d) => (
              <tr key={d.documentId} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ ...textCell, ...firstCol, overflowWrap: 'anywhere' }}>{d.fileName}</td>
                <td style={{ ...textCell, whiteSpace: 'nowrap' }}>
                  {d.periodStart || '—'} → {d.periodEnd || '—'}
                </td>
                <td style={cell}>{d.rowCount}</td>
                <td style={{ ...textCell, ...lastCol }}>
                  {d.excludedReason === null ? (
                    <span style={{ color: 'var(--good)' }}>yes</span>
                  ) : (
                    <span style={{ color: 'var(--warn)' }}>no — {d.excludedReason}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.sources.rateSourceNotes.length > 0 && (
        <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
          Rates read from: {view.sources.rateSourceNotes.join('; ')}
        </p>
      )}
    </details>
  );
}

/* --------------------------------------------------------------------- */

function SaveReturn({ view, onSaved }: { view: IftaReturnView; onSaved: () => void }) {
  const [savedBy, setSavedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const blocked = saveBlockReason(view);

  const submit = useCallback(async () => {
    if (view.entityId === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await saveIftaReturn({
        from: view.from,
        to: view.to,
        entityId: view.entityId,
        savedBy,
      });
      setMessage({ tone: 'good', text: `Saved — ${r.lineCount} jurisdiction lines, run ${r.calcRunId}.` });
      onSaved();
    } catch (err) {
      setMessage({ tone: 'bad', text: errorMessageFor(err, 'Could not save the return.') });
    } finally {
      setBusy(false);
    }
  }, [view, savedBy, onSaved]);

  return (
    <section
      style={{
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '0.9rem',
        marginBottom: '1.5rem',
      }}
    >
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Save this as a filed return</h2>
      {blocked !== null ? (
        <p style={{ color: 'var(--muted)', margin: 0 }}>{blocked}</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
          <label style={label}>
            Saved by
            <input
              style={control}
              value={savedBy}
              placeholder="your name"
              onChange={(e) => setSavedBy(e.target.value)}
            />
          </label>
          <button type="button" disabled={busy || savedBy.trim() === ''} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Save return'}
          </button>
        </div>
      )}
      {message !== null && (
        <p style={{ color: message.tone === 'good' ? 'var(--good)' : 'var(--bad)', marginBottom: 0 }}>
          {message.text}
        </p>
      )}
    </section>
  );
}

/**
 * The rate table.
 *
 * On the same screen as the return rather than behind a settings link,
 * because a missing rate is the most common reason a return is incomplete
 * and the withheld jurisdictions are listed right here as the rows to
 * fill. `sourceNote` is required by the server; the field says why.
 */
function RatePanel({ view, onRateAdded }: { view: IftaReturnView | null; onRateAdded: () => void }) {
  const year = view?.quarter.year ?? new Date().getUTCFullYear();
  const quarter = view?.quarter.quarter ?? Math.floor(new Date().getUTCMonth() / 3) + 1;

  const [rates, setRates] = useState<FetchState<IftaRatesResponse>>(loading());
  const [form, setForm] = useState({
    jurisdiction: '',
    ratePerGallon: '',
    surchargePerGallon: '',
    sourceNote: '',
    enteredBy: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setRates(loading());
    getIftaRates(year, quarter)
      .then((r) => setRates(loaded(r)))
      .catch((err) => setRates(errored(errorMessageFor(err, 'Could not load the rate table.'))));
  }, [year, quarter]);

  useEffect(load, [load]);

  const missing = view?.result ? withheldJurisdictions(view.result.problems) : [];

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postIftaRate({
        jurisdiction: form.jurisdiction,
        year,
        quarter,
        ratePerGallon: form.ratePerGallon,
        ...(form.surchargePerGallon.trim() !== '' ? { surchargePerGallon: form.surchargePerGallon } : {}),
        sourceNote: form.sourceNote,
        enteredBy: form.enteredBy,
      });
      setRates(loaded(r));
      setForm((f) => ({ ...f, jurisdiction: '', ratePerGallon: '', surchargePerGallon: '' }));
      onRateAdded();
    } catch (err) {
      setError(errorMessageFor(err, 'Could not save the rate.'));
    } finally {
      setBusy(false);
    }
  }, [form, year, quarter, onRateAdded]);

  return (
    <section style={{ borderTop: '1px solid var(--line)', paddingTop: '1rem' }}>
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.35rem' }}>
        Tax rates — {year} Q{quarter}
      </h2>
      <p style={{ color: 'var(--muted)', margin: '0 0 0.75rem', maxWidth: '54rem' }}>
        Published quarterly by IFTA, Inc. No document this system ingests carries them, so a named person
        typing one, and saying where they read it, is the whole of a rate&rsquo;s provenance.
      </p>

      {missing.length > 0 && (
        <p style={{ color: 'var(--warn)', marginTop: 0 }}>
          Miles were run in {missing.join(', ')} with no rate on file. Those lines are withheld from the
          total above until a rate is entered.
        </p>
      )}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.6rem 0.75rem',
          alignItems: 'flex-end',
          marginBottom: '0.9rem',
        }}
      >
        <label style={{ ...label, flex: '0 1 6rem' }}>
          State
          <input
            style={control}
            maxLength={2}
            placeholder="IN"
            value={form.jurisdiction}
            onChange={(e) => setForm({ ...form, jurisdiction: e.target.value.toUpperCase() })}
          />
        </label>
        <label style={{ ...label, flex: '0 1 9rem' }}>
          Rate $/gal
          <input
            style={control}
            inputMode="decimal"
            placeholder="0.34000"
            value={form.ratePerGallon}
            onChange={(e) => setForm({ ...form, ratePerGallon: e.target.value })}
          />
        </label>
        <label style={{ ...label, flex: '0 1 9rem' }}>
          Surcharge $/gal
          <input
            style={control}
            inputMode="decimal"
            placeholder="0.00000"
            value={form.surchargePerGallon}
            onChange={(e) => setForm({ ...form, surchargePerGallon: e.target.value })}
          />
        </label>
        <label style={{ ...label, flex: '1 1 14rem' }}>
          Where you read it
          <input
            style={control}
            placeholder="IFTA Inc. Q2 2026 tax rate matrix"
            value={form.sourceNote}
            onChange={(e) => setForm({ ...form, sourceNote: e.target.value })}
          />
        </label>
        <label style={{ ...label, flex: '0 1 10rem' }}>
          Entered by
          <input
            style={control}
            placeholder="your name"
            value={form.enteredBy}
            onChange={(e) => setForm({ ...form, enteredBy: e.target.value })}
          />
        </label>
        <button
          type="button"
          disabled={
            busy ||
            form.jurisdiction.trim() === '' ||
            form.ratePerGallon.trim() === '' ||
            form.sourceNote.trim() === '' ||
            form.enteredBy.trim() === ''
          }
          onClick={() => void submit()}
        >
          {busy ? 'Saving…' : 'Save rate'}
        </button>
      </div>

      {error !== null && <p style={{ color: 'var(--bad)' }}>{error}</p>}

      {rates.status === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading rates…</p>}
      {rates.status === 'error' && <p style={{ color: 'var(--bad)' }}>{rates.message}</p>}
      {rates.status === 'loaded' && rates.data.rates.length === 0 && (
        <p style={{ color: 'var(--muted)' }}>
          No rates on file for {year} Q{quarter}.
        </p>
      )}
      {rates.status === 'loaded' && rates.data.rates.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
                <th style={{ ...textHead, ...firstCol }}>State</th>
                <th style={headCell}>Rate</th>
                <th style={headCell}>Surcharge</th>
                <th style={textHead}>Source</th>
                <th style={{ ...textHead, ...lastCol }}>Entered by</th>
              </tr>
            </thead>
            <tbody>
              {rates.data.rates.map((r) => (
                <tr key={r.jurisdiction} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ ...textCell, ...firstCol, fontWeight: 600 }}>{r.jurisdiction}</td>
                  <td style={cell}>{formatDecimalString(r.ratePerGallon)}</td>
                  <td style={{ ...cell, color: r.surchargePerGallon === '0.00000' ? 'var(--muted)' : 'var(--fg)' }}>
                    {formatDecimalString(r.surchargePerGallon)}
                  </td>
                  <td style={{ ...textCell, overflowWrap: 'anywhere' }}>{r.sourceNote}</td>
                  <td style={{ ...textCell, ...lastCol, overflowWrap: 'anywhere' }}>{r.enteredBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
