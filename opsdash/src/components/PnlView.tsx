'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Grain } from '@/contract/types';
import type { EntityPnlResult, GroupPnlResult, PnlBucket, TruckPnlResult } from '@/engines/summary';
import type { PnlResponse, PnlScope } from '@/db/repo/pnl';
import { getPnl, getReferenceData } from './data/api';
import { errorMessageFor, errored, loaded, loading, type FetchState } from './data/fetchState';
import type { ReferenceData } from './data/types';
import { formatMoney } from './format/decimal';
import {
  barShare,
  byLargestCost,
  categoryGroupLabel,
  caveatsFor,
  isPartialPeriod,
  marginPercent,
  periodLabel,
} from './pnl/logic';

/**
 * The accounting P&L.
 *
 * Three form decisions, all from the visualisation guidance rather than
 * taste:
 *
 *  - **The headline numbers are stat tiles, not a chart.** Four single
 *    values are four numbers; a chart of them would render each less
 *    precisely than type does and imply comparisons between revenue and a
 *    percentage that do not exist.
 *  - **The series is a table, with one sparkline.** Margin over time is a
 *    real trend worth seeing at a glance. Revenue and margin are different
 *    scales, so they do NOT share a plot with two y-axes — the single most
 *    common charting error. The table carries both precisely; the
 *    sparkline carries margin's shape only.
 *  - **Cost composition is a table with in-cell bars, not a pie.** Eight
 *    category groups is past the point where a pie communicates anything,
 *    and the numbers are what an accountant is actually reading.
 *
 * The caveat band under the tiles is the part that matters most. A margin
 * shown without the rows nobody has assigned to company or driver yet is a
 * lower bound wearing a margin's clothes.
 */

const GRAIN_OPTIONS: { value: Grain | ''; label: string }[] = [
  { value: '', label: 'Whole period' },
  { value: 'month', label: 'By month' },
  { value: 'quarter', label: 'By quarter' },
  { value: 'week', label: 'By week' },
  { value: 'day', label: 'By day' },
];

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export function PnlView() {
  const initial = useMemo(defaultRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [grain, setGrain] = useState<Grain | ''>('month');
  const [entityId, setEntityId] = useState('');
  const [truckId, setTruckId] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [state, setState] = useState<FetchState<{ total: PnlResponse; series: PnlResponse | null }>>(
    loading(),
  );
  const [reference, setReference] = useState<ReferenceData | null>(null);

  useEffect(() => {
    let cancelled = false;
    getReferenceData()
      .then((r) => {
        if (!cancelled) setReference(r);
      })
      // A missing picker list degrades the filters to "all"; it must not
      // take the P&L itself down with it.
      .catch(() => {
        if (!cancelled) setReference(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const scope: PnlScope = truckId !== '' ? 'truck' : entityId !== '' ? 'entity' : 'group';

  useEffect(() => {
    let cancelled = false;
    setState(loading());

    const base = {
      from,
      to,
      scope,
      ...(entityId !== '' ? { entityId } : {}),
      ...(truckId !== '' ? { truckId } : {}),
    };

    // The headline is the whole range and the table is the series. Both
    // come from the engine rather than the series being re-added here:
    // summing buckets in the UI would be a second implementation of
    // arithmetic the engine already owns and property-tests, and two
    // implementations are how two screens start disagreeing. The nesting
    // invariant is what makes these two responses agree to the cent.
    Promise.all([getPnl(base), grain === '' ? Promise.resolve(null) : getPnl({ ...base, grain })])
      .then(([total, series]) => {
        if (!cancelled) setState(loaded({ total, series }));
      })
      .catch((err) => {
        if (!cancelled) setState(errored(errorMessageFor(err, 'Could not load the P&L.')));
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, grain, scope, entityId, truckId, reloadKey]);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <div>
      <Filters
        from={from}
        to={to}
        grain={grain}
        entityId={entityId}
        truckId={truckId}
        reference={reference}
        onFrom={setFrom}
        onTo={setTo}
        onGrain={setGrain}
        onEntity={(v) => {
          setEntityId(v);
          // A truck belongs to one entity; leaving a stale truck selected
          // under a different entity would return an empty P&L that looks
          // like "this entity earned nothing".
          setTruckId('');
        }}
        onTruck={setTruckId}
      />

      {state.status === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading the P&L…</p>}

      {state.status === 'error' && (
        <div
          role="alert"
          style={{
            color: 'var(--bad)',
            border: '1px solid var(--bad)',
            borderRadius: 8,
            padding: '0.75rem',
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>Could not load the P&amp;L</p>
          <p style={{ margin: '0.25rem 0 0' }}>{state.message}</p>
          <button type="button" onClick={retry} style={{ marginTop: '0.5rem' }}>
            Retry
          </button>
        </div>
      )}

      {state.status === 'loaded' && <Loaded total={state.data.total} series={state.data.series} />}
    </div>
  );
}

/* --------------------------------------------------------------------- */

function Filters(props: {
  from: string;
  to: string;
  grain: Grain | '';
  entityId: string;
  truckId: string;
  reference: ReferenceData | null;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  onGrain: (v: Grain | '') => void;
  onEntity: (v: string) => void;
  onTruck: (v: string) => void;
}) {
  // A <select>'s intrinsic width is set by its widest option, which on a
  // phone is wider than the screen. Without `minWidth: 0` a flex item
  // refuses to shrink below that, and the whole page scrolls sideways.
  const label: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
    fontSize: '0.8rem',
    color: 'var(--muted)',
    flex: '1 1 9rem',
    minWidth: 0,
  };
  const control: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box' };

  return (
    <div
      style={{
        display: 'flex',
        gap: '1rem',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
        padding: '0.75rem 0 1rem',
        borderBottom: '1px solid var(--line)',
        marginBottom: '1.25rem',
      }}
    >
      <label style={label}>
        From
        <input style={control} type="date" value={props.from} onChange={(e) => props.onFrom(e.target.value)} />
      </label>
      <label style={label}>
        To
        <input style={control} type="date" value={props.to} onChange={(e) => props.onTo(e.target.value)} />
      </label>
      <label style={label}>
        Breakdown
        <select style={control} value={props.grain} onChange={(e) => props.onGrain(e.target.value as Grain | '')}>
          {GRAIN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label style={label}>
        Company
        <select style={control} value={props.entityId} onChange={(e) => props.onEntity(e.target.value)}>
          <option value="">All (group, consolidated)</option>
          {(props.reference?.entities ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <label style={label}>
        Truck
        <select style={control} value={props.truckId} onChange={(e) => props.onTruck(e.target.value)}>
          <option value="">All trucks</option>
          {(props.reference?.trucks ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/* --------------------------------------------------------------------- */

function Loaded({ total, series }: { total: PnlResponse; series: PnlResponse | null }) {
  const bucket = total.results[0];
  if (bucket === undefined) {
    return <p style={{ color: 'var(--muted)' }}>No periods in that range.</p>;
  }

  return (
    <div>
      <ScopeLine response={total} />
      <StatTiles bucket={bucket} />
      <Caveats bucket={bucket} workQueue={total.workQueue} />
      <CostComposition bucket={bucket} />
      {series !== null && series.results.length > 1 && (
        <PeriodTable results={series.results} grain={series.grain} />
      )}
      <Breakdown response={total} />
    </div>
  );
}

/** Says plainly what is being totalled. A P&L whose scope is implicit is
 *  the easiest figure on a dashboard to quote out of context. */
function ScopeLine({ response }: { response: PnlResponse }) {
  const what =
    response.scope === 'truck'
      ? 'One truck'
      : response.scope === 'entity'
        ? 'One company'
        : 'The group, consolidated (intercompany legs eliminated)';
  return (
    <p style={{ color: 'var(--muted)', margin: '0 0 0.75rem' }}>
      {what} · {response.from} to {response.to}
    </p>
  );
}

function StatTiles({ bucket }: { bucket: PnlBucket }) {
  const pct = marginPercent(bucket.revenue, bucket.margin);
  const marginCents = bucket.margin.startsWith('-');
  return (
    // Flex rather than grid: inside `repeat(auto-fit, minmax(...))` a
    // percentage has no definite basis to resolve against, so
    // `min(180px, 100%)` collapses to a flat 180px and two columns plus a
    // gap overflow a 400px phone — which then widens the whole document
    // and pushes every table and the nav off the right edge with it.
    // Flex items shrink below their basis, so they wrap instead.
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.75rem',
        marginBottom: '1.25rem',
      }}
    >
      <Tile label="Revenue" value={formatMoney(bucket.revenue)} />
      <Tile label="Company cost" value={formatMoney(bucket.companyCostTotal)} />
      <Tile
        label="Margin"
        value={formatMoney(bucket.margin)}
        tone={marginCents ? 'bad' : 'good'}
        sub={pct === null ? 'no revenue in this period' : `${pct} of revenue`}
      />
      <Tile label="Days" value={String(bucket.days)} sub={`${bucket.entryCount} ledger rows`} />
    </div>
  );
}

function Tile(props: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '0.75rem 0.9rem',
        flex: '1 1 160px',
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>{props.label}</div>
      <div
        style={{
          fontSize: '1.5rem',
          fontWeight: 650,
          fontVariantNumeric: 'tabular-nums',
          overflowWrap: 'anywhere',
          color: props.tone === 'bad' ? 'var(--bad)' : props.tone === 'good' ? 'var(--good)' : 'var(--fg)',
        }}
      >
        {props.value}
      </div>
      {props.sub !== undefined && (
        <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.15rem' }}>{props.sub}</div>
      )}
    </div>
  );
}

function Caveats({
  bucket,
  workQueue,
}: {
  bucket: PnlBucket;
  workQueue: PnlResponse['workQueue'];
}) {
  const caveats = caveatsFor(bucket, workQueue);
  return (
    <details open style={{ marginBottom: '1.25rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
        What these totals do not include
      </summary>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem' }}>
        <tbody>
          {caveats.map((c) => (
            <tr key={c.id} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={{ padding: '0.5rem 0.5rem 0.5rem 0', verticalAlign: 'top', overflowWrap: 'anywhere' }}>
                <div style={{ fontWeight: 600 }}>{c.label}</div>
                <div style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>{c.detail}</div>
              </td>
              <td
                style={{
                  padding: '0.5rem 0',
                  textAlign: 'right',
                  whiteSpace: 'nowrap',
                  fontVariantNumeric: 'tabular-nums',
                  verticalAlign: 'top',
                }}
              >
                {c.amount === null ? '—' : formatMoney(c.amount)}
                {c.count > 0 && (
                  <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
                    {c.count} row{c.count === 1 ? '' : 's'}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function CostComposition({ bucket }: { bucket: PnlBucket }) {
  const groups = byLargestCost(bucket.companyCostByCategoryGroup);
  if (groups.length === 0) {
    return <p style={{ color: 'var(--muted)' }}>No company cost in this period.</p>;
  }
  const largest = groups[0]!.amount;

  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Company cost by category</h2>
      <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 340 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: '0.8rem' }}>
            <th style={{ padding: '0.35rem 0' }}>Category</th>
            <th style={{ padding: '0.35rem 0', width: '45%' }}>Share</th>
            <th style={{ padding: '0.35rem 0', textAlign: 'right' }}>Amount</th>
            <th style={{ padding: '0.35rem 0', textAlign: 'right' }}>Rows</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.categoryGroup} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={{ padding: '0.4rem 0.5rem 0.4rem 0' }}>{categoryGroupLabel(g.categoryGroup)}</td>
              <td style={{ padding: '0.4rem 0.5rem 0.4rem 0' }}>
                <div
                  aria-hidden="true"
                  style={{
                    height: 8,
                    borderRadius: 4,
                    width: `${barShare(g.amount, largest) * 100}%`,
                    minWidth: 2,
                    background: 'var(--accent)',
                  }}
                />
              </td>
              <td
                style={{
                  padding: '0.4rem 0',
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatMoney(g.amount)}
              </td>
              <td style={{ padding: '0.4rem 0', textAlign: 'right', color: 'var(--muted)' }}>
                {g.entryCount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {bucket.allocatedAmounts.length > 0 && (
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
          Includes{' '}
          {bucket.allocatedAmounts
            .map(
              (a) =>
                `${formatMoney(a.amount)} of ${categoryGroupLabel(a.categoryGroup)} allocated ${a.allocationBasis.replace(/_/g, ' ')}`,
            )
            .join('; ')}
          . An allocated figure is a share of a bill, not a measurement of this unit.
        </p>
      )}
    </section>
  );
}

function PeriodTable({
  results,
  grain,
}: {
  results: readonly PnlBucket[];
  grain: Grain | null;
}) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>By period</h2>
      {/* Twelve rows of margin are readable as type; a line above them
          repeats the table less precisely. Past that the table stops
          fitting on a screen and the shape starts doing work type cannot. */}
      {results.length > 12 && <MarginSparkline results={results} />}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: '0.8rem' }}>
              <th style={{ padding: '0.35rem 0' }}>Period</th>
              <th style={{ padding: '0.35rem 0', textAlign: 'right' }}>Revenue</th>
              <th style={{ padding: '0.35rem 0', textAlign: 'right' }}>Company cost</th>
              <th style={{ padding: '0.35rem 0', textAlign: 'right' }}>Margin</th>
              <th style={{ padding: '0.35rem 0', textAlign: 'right' }}>Margin %</th>
              <th style={{ padding: '0.35rem 0', textAlign: 'right' }}>Cost / day</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const partial = isPartialPeriod(r, grain);
              const pct = marginPercent(r.revenue, r.margin);
              return (
                <tr key={`${r.periodStart}-${r.periodEnd}`} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', whiteSpace: 'nowrap' }}>
                    {periodLabel(r, grain)}
                    {partial && (
                      // A clamped bucket sitting beside full ones would read
                      // as a bad period rather than a short one.
                      <span
                        style={{ color: 'var(--warn)', fontSize: '0.78rem', marginLeft: '0.4rem' }}
                        title={`Only ${r.days} day${r.days === 1 ? '' : 's'} of this period are inside the selected range`}
                      >
                        part ({r.days}d)
                      </span>
                    )}
                  </td>
                  <Num>{formatMoney(r.revenue)}</Num>
                  <Num>{formatMoney(r.companyCostTotal)}</Num>
                  <Num tone={r.margin.startsWith('-') ? 'bad' : undefined}>{formatMoney(r.margin)}</Num>
                  <Num>{pct ?? '—'}</Num>
                  <Num>{formatMoney(r.costPerDay)}</Num>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Num({ children, tone }: { children: React.ReactNode; tone?: 'bad' }) {
  return (
    <td
      style={{
        padding: '0.4rem 0',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        color: tone === 'bad' ? 'var(--bad)' : undefined,
      }}
    >
      {children}
    </td>
  );
}

/**
 * Margin's shape over the series — one measure, one scale, no axis pair.
 * Revenue is deliberately absent: plotting it here would mean two y-axes,
 * and the table two inches below carries both to the cent anyway.
 */
function MarginSparkline({ results }: { results: readonly PnlBucket[] }) {
  const points = results.map((r) => Number(r.margin));
  if (points.length < 2 || points.some((p) => !Number.isFinite(p))) return null;

  const max = Math.max(...points, 0);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const w = 100;
  const h = 24;
  const x = (i: number) => (i / (points.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / span) * h;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p).toFixed(2)}`).join(' ');
  const zeroY = y(0).toFixed(2);

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Margin by period. The table below carries the same figures exactly."
      style={{ width: '100%', height: 40, marginBottom: '0.5rem', display: 'block' }}
    >
      <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * The drill-down. A group result carries its entities; an entity result
 * carries its trucks and whatever it could not attribute to one. The
 * unattributed bucket is shown rather than folded into a fictitious truck,
 * because a truck list that silently absorbs office costs is a truck list
 * that lies about per-truck economics.
 */
function Breakdown({ response }: { response: PnlResponse }) {
  const first = response.results[0];
  if (first === undefined || response.results.length !== 1) return null;

  if (response.scope === 'group') {
    const group = first as GroupPnlResult;
    return (
      <section>
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>By company</h2>
        <RowTable
          rows={group.entities.map((e) => ({
            key: e.entityId,
            label: e.entityId,
            revenue: e.revenue,
            cost: e.companyCostTotal,
            margin: e.margin,
          }))}
        />
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
          The group total is consolidated: {formatMoney(group.eliminatedIntercompany)} of intercompany
          movement is eliminated, so a dollar that moved between two of these companies is not counted
          twice. Each company&rsquo;s own row keeps it, because it is a real fact about that
          company&rsquo;s books.
        </p>
      </section>
    );
  }

  if (response.scope === 'entity') {
    const entity = first as EntityPnlResult;
    return (
      <section>
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>By truck</h2>
        <RowTable
          rows={[
            ...entity.trucks.map((t: TruckPnlResult) => ({
              key: t.truckId,
              label: t.truckId,
              revenue: t.revenue,
              cost: t.companyCostTotal,
              margin: t.margin,
            })),
            {
              key: '__unattributed',
              label: 'Not attributed to a truck',
              revenue: entity.unattributed.revenue,
              cost: entity.unattributed.companyCostTotal,
              margin: entity.unattributed.margin,
            },
          ]}
        />
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
          Trucks plus the unattributed row equal this company exactly. Office costs, fleet-level
          payments and intercompany legs live in that last row rather than being spread across trucks
          that did not incur them.
        </p>
      </section>
    );
  }

  return (
    <p style={{ color: 'var(--muted)' }}>
      <Link href="/review" style={{ color: 'var(--accent)' }}>
        Review queue
      </Link>{' '}
      — every figure above traces to a committed document row.
    </p>
  );
}

function RowTable({
  rows,
}: {
  rows: readonly { key: string; label: string; revenue: string; cost: string; margin: string }[];
}) {
  if (rows.length === 0) return <p style={{ color: 'var(--muted)' }}>Nothing in this period.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480, marginBottom: '0.5rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: '0.8rem' }}>
            <th style={{ padding: '0.35rem 0' }}>Name</th>
            <th style={{ padding: '0.35rem 0', textAlign: 'right' }}>Revenue</th>
            <th style={{ padding: '0.35rem 0', textAlign: 'right' }}>Company cost</th>
            <th style={{ padding: '0.35rem 0', textAlign: 'right' }}>Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' }}>
                {r.label}
              </td>
              <Num>{formatMoney(r.revenue)}</Num>
              <Num>{formatMoney(r.cost)}</Num>
              <Num tone={r.margin.startsWith('-') ? 'bad' : undefined}>{formatMoney(r.margin)}</Num>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
