'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CeoResponse, EntityPosition, TruckPosition } from '@/db/repo/ceo';
import type { MetricForecast } from '@/engines/forecast';
import { getCeoView } from './data/api';
import { errorMessageFor, errored, loaded, loading, type FetchState } from './data/fetchState';
import { formatMoney } from './format/decimal';

/**
 * The CEO board.
 *
 * Two rules from the build contract decide everything about how this looks.
 *
 * *"A forecast rendered like an actual is the single worst failure this
 * dashboard can have."* So the forecast lives behind a dashed fence, every
 * figure is a range rather than a point, and the back-test that produced
 * the range sits beside it instead of behind a tooltip. A reader glancing
 * at this page cannot mistake next week for last week even by accident.
 *
 * And *"every number must trace to a source document or connector pull —
 * no silent estimates presented as actuals."* Here that is visible rather
 * than merely true: a measured figure, a modelled one and a forecast each
 * carry a word, because a reader should not have to know the colour code.
 *
 * The rest is scanning order. A board is looked at, not read: the group's
 * position first and largest, then which company is carrying the loss,
 * then which trucks. The truck list is worst-first — a profitable-truck
 * list sorted best-first is a reassurance, and the useful question is which
 * units are losing money.
 */

function marginTone(value: string | null): string {
  if (value === null) return 'var(--muted)';
  return value.startsWith('-') ? 'var(--bad)' : 'var(--good)';
}

/** A withheld margin renders as an em dash with its reason, never as a
 *  number. See `marginOf` in db/repo/ceo.ts for what that protects against:
 *  revenue printed as margin, to the cent. */
function marginText(value: string | null): string {
  return value === null ? '—' : formatMoney(value);
}

/**
 * Margin as a share of revenue — but only while that is a sentence a person
 * can read. Against a period where cost dwarfs revenue the honest figure is
 * "-2420.2%", which is arithmetically right and communicates nothing; it
 * reads as a rendering fault. Past 10x the multiple says it better.
 */
function pct(margin: string | null, revenue: string): string | null {
  if (margin === null) return null;
  const r = Number(revenue);
  if (!Number.isFinite(r) || r === 0) return null;
  const ratio = Number(margin) / r;
  if (Math.abs(ratio) >= 10) return `${Math.abs(ratio).toFixed(0)}x revenue`;
  return `${(ratio * 100).toFixed(1)}%`;
}

/** The widest absolute value in a column, so every bar in one table shares
 *  one scale. Bars scaled per row would make a small loss look like a large
 *  one, which is worse than drawing no bar at all. */
function scaleOf(values: Array<string | null>): number {
  const max = Math.max(0, ...values.filter((v): v is string => v !== null).map((v) => Math.abs(Number(v))));
  return max === 0 ? 1 : max;
}

/** A bar that runs left from centre for a loss and right for a profit. The
 *  centre line is drawn, so zero is a position on the page rather than
 *  something the reader infers. */
function MarginBar({ value, scale }: { value: string | null; scale: number }) {
  if (value === null) return <div className="bar-track" aria-hidden="true" />;
  const n = Number(value);
  const half = Math.min(50, (Math.abs(n) / scale) * 50);
  const negative = n < 0;
  return (
    <div className="bar-track" role="img" aria-label={`${negative ? 'loss' : 'profit'} of ${formatMoney(value)}`}>
      <div
        className="bar-fill"
        style={{
          left: negative ? `${50 - half}%` : '50%',
          width: `${half}%`,
          background: negative ? 'var(--bad)' : 'var(--good)',
        }}
      />
      <div className="bar-zero" style={{ left: '50%' }} />
    </div>
  );
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
    <div className="board">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1rem', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
          From
          <input id="ceo-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
          To
          <input id="ceo-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {state.status === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      {state.status === 'error' && (
        <p role="alert" style={{ color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 'var(--radius)', padding: '0.75rem' }}>
          {state.message}
        </p>
      )}

      {state.status === 'loaded' && (
        <>
          <GroupPosition data={state.data} />
          <ByCompany data={state.data} />
          <WorstTrucks data={state.data} />
          <ForecastPanel forecast={state.data.forecast} />
          <NotIncluded problems={state.data.problems} />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function GroupPosition({ data }: { data: CeoResponse }) {
  const g = data.group;
  if (g.entryCount === 0) {
    return (
      <p style={{ color: 'var(--muted)' }}>
        No ledger entries in this period. Not zero — nothing has been posted yet.
      </p>
    );
  }
  const marginPct = pct(g.margin, g.revenue);

  return (
    <section className="board-section">
      <div className="board-head">
        <h2>Group position</h2>
        <span style={{ color: 'var(--muted)', fontSize: '0.82em', fontVariantNumeric: 'tabular-nums' }}>
          {data.from} → {data.to} · {g.entryCount} entries
        </span>
      </div>

      <div className="hero-row">
        <div className="hero">
          <span className="hero-label">Revenue</span>
          <span className="hero-value">{formatMoney(g.revenue)}</span>
          <span className="hero-sub"><span className="chip chip-muted">measured</span></span>
        </div>
        <div className="hero">
          <span className="hero-label">Company cost</span>
          <span className="hero-value">{formatMoney(g.companyCost)}</span>
          <span className="hero-sub"><span className="chip chip-muted">measured + modelled</span></span>
        </div>
        <div className="hero hero-lead">
          <span className="hero-label">Margin</span>
          <span className="hero-value" style={{ color: marginTone(g.margin) }}>{marginText(g.margin)}</span>
          <span className="hero-sub">{g.marginBlocked ?? (marginPct ? (marginPct.endsWith('x revenue') ? `cost is ${marginPct}` : `${marginPct} of revenue`) : '')}</span>
        </div>
        <div className="hero">
          <span className="hero-label">Trucks with activity</span>
          <span className="hero-value">{data.trucks.length === 0 ? '—' : data.trucks.length}</span>
          <span className="hero-sub">
            {/* "0 losing money" against no truck data reads as good news. It
                is the absence of the data, and the tile has to say so. */}
            {data.trucks.length === 0
              ? 'no entry in this period carries a unit'
              : `${data.trucks.filter((t) => t.margin !== null && Number(t.margin) < 0).length} losing money`}
          </span>
        </div>
      </div>

      {data.problems.length > 0 && (
        <p className="board-note" style={{ color: 'var(--warn)' }}>
          <span className="chip chip-warn">incomplete</span>{' '}
          Figures are missing from these totals, and they are missing from both sides: cost streams
          that have not been posted, and rows still held for review. This is a position, not a result,
          and it can move in either direction as they land. What is excluded is listed at the foot of
          the page.
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function ByCompany({ data }: { data: CeoResponse }) {
  const withEntries = data.entities.filter((e) => e.entryCount > 0);
  const scale = scaleOf(withEntries.map((e) => e.margin));

  return (
    <section className="board-section">
      <div className="board-head">
        <h2>By company</h2>
      </div>
      <div className="board-table-wrap">
        <table className="board-table">
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Revenue</th>
              <th scope="col">Company cost</th>
              <th scope="col">Margin</th>
              <th scope="col">vs revenue</th>
              <th scope="col" className="bar-cell" style={{ textAlign: 'left' }}>Loss ← → Profit</th>
              <th scope="col">Entries</th>
            </tr>
          </thead>
          <tbody>
            {data.entities.map((e: EntityPosition) => {
              const empty = e.entryCount === 0;
              const p = empty ? null : pct(e.margin, e.revenue);
              return (
                <tr key={e.entityId}>
                  <td style={{ fontWeight: 700 }}>
                    {e.code}
                    <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: '0.5em', fontSize: '0.85em' }}>
                      {e.legalName}
                    </span>
                  </td>
                  <td>{empty ? '—' : formatMoney(e.revenue)}</td>
                  <td>{empty ? '—' : formatMoney(e.companyCost)}</td>
                  <td style={{ fontWeight: 700, color: empty ? 'var(--muted)' : marginTone(e.margin) }}>
                    {empty ? '—' : marginText(e.margin)}
                  </td>
                  <td style={{ color: 'var(--muted)' }}>{p ?? '—'}</td>
                  <td className="bar-cell">{empty ? null : <MarginBar value={e.margin} scale={scale} />}</td>
                  <td style={{ color: 'var(--muted)' }}>{e.entryCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="board-note">
        A company with no entries reads &ldquo;—&rdquo;, never $0.00 — nothing posted is not the same as nothing earned.
        The bars share one scale, so their lengths are comparable across rows.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function WorstTrucks({ data }: { data: CeoResponse }) {
  const shown = data.trucks.slice(0, 15);
  const scale = scaleOf(shown.map((t) => t.margin));
  if (shown.length === 0) return null;

  return (
    <section className="board-section">
      <div className="board-head">
        <h2>Trucks, worst first</h2>
        <span style={{ color: 'var(--muted)', fontSize: '0.82em' }}>
          {shown.length} of {data.trucks.length}
        </span>
      </div>
      <div className="board-table-wrap">
        <table className="board-table">
          <thead>
            <tr>
              <th scope="col">Unit</th>
              <th scope="col">Company</th>
              <th scope="col">Revenue</th>
              <th scope="col">Cost</th>
              <th scope="col">Margin</th>
              <th scope="col" className="bar-cell" style={{ textAlign: 'left' }}>Loss ← → Profit</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t: TruckPosition) => (
              <tr key={t.truckId}>
                <td style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{t.unitNumber}</td>
                <td style={{ color: 'var(--muted)' }}>{t.entityCode ?? '—'}</td>
                <td>{formatMoney(t.revenue)}</td>
                <td>{formatMoney(t.companyCost)}</td>
                <td style={{ fontWeight: 700, color: marginTone(t.margin) }}>{marginText(t.margin)}</td>
                <td className="bar-cell"><MarginBar value={t.margin} scale={scale} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="board-note">
        A truck with no ledger activity is absent from this list, not shown at zero. Nobody posting anything
        for a unit is different from that unit breaking even.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */

/**
 * How wrong the method has been, drawn.
 *
 * A forecast with no error history is a confident line, and a confident
 * line is the thing this panel exists to avoid. Predicted and actual are
 * drawn on ONE scale — two y-axes would make any method look accurate.
 */
function BackTestChart({ m }: { m: MetricForecast }) {
  const pts = m.backTest;
  if (pts.length < 2) return null;

  const W = 260;
  const H = 64;
  const PAD = 4;
  const values = pts.flatMap((p) => [Number(p.actual), Number(p.predicted)]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / (pts.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const line = (get: (p: (typeof pts)[number]) => string) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(Number(get(p))).toFixed(1)}`).join(' ');

  return (
    <figure className="spark">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Back-test of ${m.metric}: what the method predicted against what happened, over ${pts.length} closed weeks.`}
      >
        <path d={line((p) => p.predicted)} fill="none" stroke="var(--warn)" strokeWidth="1.5" strokeDasharray="3 3" />
        <path d={line((p) => p.actual)} fill="none" stroke="var(--fg)" strokeWidth="2" />
        <circle cx={x(pts.length - 1)} cy={y(Number(pts[pts.length - 1]!.actual))} r="3" fill="var(--fg)" />
      </svg>
      <figcaption style={{ color: 'var(--muted)', fontSize: '0.74rem', marginTop: '0.3rem' }}>
        <span style={{ color: 'var(--fg)' }}>——</span> actual{' '}
        <span style={{ color: 'var(--warn)' }}>- -</span> what the method would have said, {pts.length} weeks
      </figcaption>
    </figure>
  );
}

function ForecastPanel({ forecast }: { forecast: CeoResponse['forecast'] }) {
  return (
    <section className="board-section">
      <div className="board-head">
        <h2>Next week — forecast</h2>
        <span className="chip chip-warn">not an actual</span>
      </div>
      <div className="forecast-panel">
        {forecast.blocked !== null && <p style={{ margin: 0, color: 'var(--warn)' }}>{forecast.blocked}</p>}

        {forecast.metrics !== null && (
          <>
            <p className="board-note" style={{ margin: 0 }}>
              {forecast.horizonStart} → {forecast.horizonEnd} · {forecast.method} over {forecast.windowWeeks} closed weeks.
              Every figure is a range. The line below each one is how wrong this method has actually been.
            </p>
            <div className="forecast-grid">
              {forecast.metrics.map((m) => (
                <div key={m.metric}>
                  <div className="hero-label" style={{ textTransform: 'capitalize' }}>{m.metric}</div>
                  <div className="forecast-range">
                    {formatMoney(m.lowerBound)} – {formatMoney(m.upperBound)}
                  </div>
                  <div className="hero-sub" style={{ marginBottom: '0.4rem' }}>
                    typical miss {formatMoney(m.meanAbsoluteError)}
                    {Number(m.meanError) !== 0 && (
                      <> · runs {Number(m.meanError) > 0 ? 'low' : 'high'} by {formatMoney(m.meanError)}</>
                    )}
                  </div>
                  <BackTestChart m={m} />
                </div>
              ))}
            </div>
          </>
        )}

        {forecast.problems.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--muted)', fontSize: '0.85em' }}>
            {forecast.problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function NotIncluded({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <section className="board-section">
      <div className="board-head">
        <h2>What these totals do not include</h2>
        <span className="chip chip-warn">{problems.length}</span>
      </div>
      <ul style={{ margin: 0, paddingLeft: '1.2rem', color: 'var(--muted)' }}>
        {problems.map((p) => <li key={p} style={{ marginBottom: '0.35rem' }}>{p}</li>)}
      </ul>
    </section>
  );
}
