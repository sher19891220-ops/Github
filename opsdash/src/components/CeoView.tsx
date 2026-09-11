'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CeoResponse } from '@/db/repo/ceo';
import type { MetricForecast } from '@/engines/forecast';
import { getCeoView } from './data/api';
import { errorMessageFor, errored, loaded, loading, type FetchState } from './data/fetchState';
import { formatMoney } from './format/decimal';

/**
 * The CEO view.
 *
 * One rule dominates the design, and it comes straight from the build
 * contract: *"A forecast rendered like an actual is the single worst
 * failure this dashboard can have."* So the forecast lives in its own
 * panel, on a dashed border, with every figure prefixed by a range rather
 * than stated as a point — and the back-test that produced the range is
 * shown next to it rather than hidden behind a tooltip. A reader who
 * glances at this page should not be able to mistake next week for last
 * week even by accident.
 *
 * The truck table is sorted worst margin first. A list of profitable
 * trucks sorted best-first is a reassurance; the question worth a CEO's
 * attention is which units are losing money.
 */

const cell: CSSProperties = {
  padding: '0.4rem 0.6rem',
  textAlign: 'right',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
};
const headCell: CSSProperties = { ...cell, fontWeight: 600 };
const textCell: CSSProperties = { padding: '0.4rem 0.6rem', textAlign: 'left' };
const firstCol: CSSProperties = { paddingLeft: 0 };
const lastCol: CSSProperties = { paddingRight: 0 };

function marginColour(value: string | null): string {
  if (value === null) return 'var(--muted)';
  return value.startsWith('-') ? 'var(--bad)' : 'var(--good)';
}

/** A withheld margin renders as an em dash with its reason, never as a
 *  number. See `marginOf` in db/repo/ceo.ts for what it is protecting
 *  against — revenue printed as margin, to the cent. */
function marginText(value: string | null): string {
  return value === null ? '—' : formatMoney(value);
}

export function CeoView() {
  const initial = useMemo(() => {
    const y = new Date().getUTCFullYear();
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [state, setState] = useState<FetchState<CeoResponse>>(loading());

  useEffect(() => {
    let cancelled = false;
    setState(loading());
    getCeoView({ from, to })
      .then((d) => !cancelled && setState(loaded(d)))
      .catch((err) => !cancelled && setState(errored(errorMessageFor(err, 'Could not load the group view.'))));
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1rem', marginBottom: '1.25rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {state.status === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      {state.status === 'error' && (
        <p role="alert" style={{ color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 6, padding: '0.75rem' }}>
          {state.message}
        </p>
      )}

      {state.status === 'loaded' && (
        <>
          <GroupTiles data={state.data} />
          <EntityTable data={state.data} />
          <ForecastPanel forecast={state.data.forecast} />
          <TruckTable data={state.data} />
          {state.data.problems.length > 0 && (
            <details open style={{ marginTop: '1.25rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                What these totals do not include ({state.data.problems.length})
              </summary>
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem', color: 'var(--muted)' }}>
                {state.data.problems.map((p) => (
                  <li key={p} style={{ marginBottom: '0.35rem' }}>{p}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function GroupTiles({ data }: { data: CeoResponse }) {
  if (data.group.entryCount === 0) {
    return (
      <p style={{ color: 'var(--muted)' }}>
        No ledger entries in this period. Not zero — nothing has been posted yet.
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.5rem' }}>
      {[
        { label: 'Group revenue', value: formatMoney(data.group.revenue), tone: undefined, note: `${data.group.entryCount} entries · actual` },
        { label: 'Group company cost', value: formatMoney(data.group.companyCost), tone: undefined, note: `${data.group.entryCount} entries · actual` },
        {
          label: 'Group margin',
          value: marginText(data.group.margin),
          tone: marginColour(data.group.margin),
          note: data.group.marginBlocked ?? `${data.group.entryCount} entries · actual`,
        },
      ].map((t) => (
        <div key={t.label} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '0.75rem 0.9rem', flex: '1 1 12rem', minWidth: 0 }}>
          <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{t.label}</div>
          <div style={{ fontSize: 'clamp(1.05rem, 4vw, 1.45rem)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflowX: 'auto', color: t.tone ?? 'var(--fg)' }}>
            {t.value}
          </div>
          <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>{t.note}</div>
        </div>
      ))}
    </div>
  );
}

function EntityTable({ data }: { data: CeoResponse }) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>By company</h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
          <thead>
            <tr style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
              <th style={{ ...textCell, ...firstCol, fontWeight: 600 }}>Company</th>
              <th style={headCell}>Revenue</th>
              <th style={headCell}>Company cost</th>
              <th style={headCell}>Margin</th>
              <th style={{ ...headCell, ...lastCol }}>Entries</th>
            </tr>
          </thead>
          <tbody>
            {data.entities.map((e) => (
              <tr key={e.entityId} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ ...textCell, ...firstCol, fontWeight: 600 }}>{e.code}</td>
                <td style={cell}>{e.entryCount === 0 ? '—' : formatMoney(e.revenue)}</td>
                <td style={cell}>{e.entryCount === 0 ? '—' : formatMoney(e.companyCost)}</td>
                <td style={{ ...cell, fontWeight: 700, color: e.entryCount === 0 ? 'var(--muted)' : marginColour(e.margin) }}>
                  {e.entryCount === 0 ? '—' : marginText(e.margin)}
                </td>
                <td style={{ ...cell, ...lastCol, color: 'var(--muted)' }}>{e.entryCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
        A company with no entries reads &ldquo;—&rdquo;, never $0.00. Nothing posted is not the same as nothing earned.
      </p>
    </section>
  );
}

/**
 * The forecast panel.
 *
 * Dashed border, its own heading, every figure written as a range, and the
 * back-test immediately below it. None of that is decoration: the contract
 * names a forecast rendered like an actual as the worst failure this
 * screen can have, and the defence against it is that the two never look
 * alike anywhere on the page.
 */
function ForecastPanel({ forecast }: { forecast: CeoResponse['forecast'] }) {
  return (
    <section
      style={{
        border: '2px dashed var(--warn)',
        borderRadius: 8,
        padding: '0.9rem',
        marginBottom: '1.5rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
        <span
          style={{
            fontWeight: 700,
            fontSize: '0.8rem',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--warn)',
            border: '1px solid var(--warn)',
            borderRadius: 4,
            padding: '0.1rem 0.4rem',
          }}
        >
          Forecast — not an actual
        </span>
        <span style={{ color: 'var(--muted)' }}>
          {forecast.horizonStart} to {forecast.horizonEnd} · {forecast.method}
        </span>
      </div>

      {forecast.blocked !== null && (
        <p style={{ color: 'var(--muted)', marginBottom: 0 }}>{forecast.blocked}</p>
      )}

      {forecast.metrics !== null && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.85rem' }}>
            {forecast.metrics.map((m) => (
              <ForecastTile key={m.metric} m={m} />
            ))}
          </div>
          <BackTest metrics={forecast.metrics} />
        </>
      )}

      {forecast.problems.length > 0 && (
        <ul style={{ margin: '0.75rem 0 0', paddingLeft: '1.2rem', color: 'var(--warn)' }}>
          {forecast.problems.map((p) => (
            <li key={p} style={{ marginBottom: '0.3rem' }}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ForecastTile({ m }: { m: MetricForecast }) {
  return (
    <div style={{ border: '1px dashed var(--line)', borderRadius: 8, padding: '0.75rem 0.9rem', flex: '1 1 13rem', minWidth: 0 }}>
      <div style={{ color: 'var(--muted)', fontSize: '0.8rem', textTransform: 'capitalize' }}>{m.metric}</div>
      {/* The range leads, not the point estimate. A single bold number
          beside three actuals is exactly the confusion this panel exists
          to prevent. */}
      <div style={{ fontSize: 'clamp(0.95rem, 3.2vw, 1.15rem)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflowX: 'auto' }}>
        {formatMoney(m.lowerBound)} — {formatMoney(m.upperBound)}
      </div>
      <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>
        midpoint {formatMoney(m.pointEstimate)} · typically wrong by {formatMoney(m.meanAbsoluteError)}
      </div>
    </div>
  );
}

/** The measured error, week by week. The band above is derived from
 *  exactly these numbers, so showing them is what makes the band a
 *  measurement rather than a decoration. */
function BackTest({ metrics }: { metrics: MetricForecast[] }) {
  const revenue = metrics.find((m) => m.metric === 'revenue');
  if (!revenue || revenue.backTest.length === 0) return null;
  return (
    <details style={{ marginTop: '0.85rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
        How wrong this method has been ({revenue.backTest.length} weeks checked)
      </summary>
      <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 440 }}>
          <thead>
            <tr style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
              <th style={{ ...textCell, ...firstCol, fontWeight: 600 }}>Week</th>
              <th style={headCell}>It predicted</th>
              <th style={headCell}>Actual</th>
              <th style={{ ...headCell, ...lastCol }}>Off by</th>
            </tr>
          </thead>
          <tbody>
            {revenue.backTest.map((p) => (
              <tr key={p.periodStart} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ ...textCell, ...firstCol }}>{p.periodStart}</td>
                <td style={cell}>{formatMoney(p.predicted)}</td>
                <td style={cell}>{formatMoney(p.actual)}</td>
                <td style={{ ...cell, ...lastCol, color: p.error.startsWith('-') ? 'var(--bad)' : 'var(--fg)' }}>
                  {formatMoney(p.error)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
        Revenue shown. Each week was predicted using only the weeks before it — a back-test that sees the answer
        measures nothing.
      </p>
    </details>
  );
}

function TruckTable({ data }: { data: CeoResponse }) {
  if (data.trucks.length === 0) {
    return <p style={{ color: 'var(--muted)' }}>No truck has ledger activity in this period.</p>;
  }
  const losing = data.trucks.filter((t) => t.margin !== null && t.margin.startsWith('-'));
  return (
    <section>
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.35rem' }}>By truck — worst first</h2>
      <p style={{ color: 'var(--muted)', margin: '0 0 0.5rem' }}>
        {losing.length} of {data.trucks.length} trucks are negative this period.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
          <thead>
            <tr style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
              <th style={{ ...textCell, ...firstCol, fontWeight: 600 }}>Unit</th>
              <th style={{ ...textCell, fontWeight: 600 }}>Company</th>
              <th style={headCell}>Revenue</th>
              <th style={headCell}>Company cost</th>
              <th style={{ ...headCell, ...lastCol }}>Margin</th>
            </tr>
          </thead>
          <tbody>
            {data.trucks.map((t) => (
              <tr key={t.truckId} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ ...textCell, ...firstCol, fontWeight: 600 }}>{t.unitNumber}</td>
                <td style={textCell}>{t.entityCode ?? '—'}</td>
                <td style={cell}>{formatMoney(t.revenue)}</td>
                <td style={cell}>{formatMoney(t.companyCost)}</td>
                <td style={{ ...cell, ...lastCol, fontWeight: 700, color: marginColour(t.margin) }}>
                  {marginText(t.margin)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
