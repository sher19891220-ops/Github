'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getOverheadRates } from '../data/api';
import { errorMessageFor, loaded, loading, errored, type FetchState } from '../data/fetchState';
import type { TruckOverheadRate } from '../data/types';
import { formatMoney, formatRate, sumMoney } from '../format/decimal';
import { StatusPill } from '../StatusPill';
import { FINANCIAL_SNAPSHOT, WORK_QUEUE } from './snapshot';

function StatTile({
  label,
  value,
  chip,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  chip?: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="stat-tile">
      <div className="stat-tile-label">
        <span>{label}</span>
        {chip}
      </div>
      <div className="stat-tile-value num">{value}</div>
      {sub && <div className="stat-tile-sub">{sub}</div>}
    </div>
  );
}

/** "Measured, not live" chip — every tile on this page that does not read a
 *  request made just now (a static snapshot from a doc or a test, or a
 *  fixture behind a screen with no live endpoint) wears this, so nobody
 *  mistakes a snapshot for a number that just came off the server. */
function MeasuredChip() {
  return <StatusPill label="Measured, not live" tone="muted" />;
}

/**
 * The accounting lead's landing screen. Answers two questions in order:
 * what needs a decision today (a work queue, largest first, each row
 * linking to the screen that resolves it), and where the money stands
 * (stat tiles — a single value is not a chart, so no gauges here; see
 * `docs/FLEET-BOARD-SPEC.md` §3).
 *
 * Only the "registration overhead" tiles read a live endpoint
 * (`GET /api/registration/overhead`); everything else on this page is a
 * measured snapshot with no live endpoint behind it yet (see `./snapshot.ts`
 * for exactly where each number comes from) and is labelled as such rather
 * than presented as if it just came off the server.
 */
export function AccountingDashboard() {
  const [overheadState, setOverheadState] = useState<FetchState<TruckOverheadRate[]>>(loading());

  useEffect(() => {
    let cancelled = false;
    getOverheadRates()
      .then((rates) => {
        if (!cancelled) setOverheadState(loaded(rates));
      })
      .catch((err) => {
        if (!cancelled) setOverheadState(errored(errorMessageFor(err, 'Could not load registration overhead.')));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const queue = [...WORK_QUEUE].sort((a, b) => b.weight - a.weight);

  const unresolvedRates = overheadState.status === 'loaded' ? overheadState.data.filter((r) => r.truckId == null) : [];
  const unresolvedTotal = unresolvedRates.length > 0 ? sumMoney(unresolvedRates.map((r) => r.annualTotal)) : null;
  const representative = overheadState.status === 'loaded' ? (overheadState.data[0] ?? null) : null;

  return (
    <div>
      <h1>Accounting</h1>
      <p style={{ color: 'var(--muted)' }}>What needs a decision today, and where the money stands.</p>

      <h2 style={{ marginTop: '1.5rem' }}>What needs you today</h2>
      <div>
        {queue.map((item) => (
          <div key={item.id} className="work-queue-row">
            <span className="work-queue-count">{item.count}</span>
            <span style={{ flex: 1 }}>
              {item.label}
              {item.note && (
                <div style={{ color: 'var(--muted)', fontSize: '0.85em', marginTop: '0.15rem' }}>{item.note}</div>
              )}
            </span>
            {item.href ? (
              <Link href={item.href} style={{ color: 'var(--accent)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                Resolve →
              </Link>
            ) : (
              <span style={{ color: 'var(--muted)', fontSize: '0.85em', whiteSpace: 'nowrap' }}>No action here</span>
            )}
          </div>
        ))}
      </div>

      <h2 style={{ marginTop: '2rem' }}>Where the money stands</h2>
      <div className="stat-grid">
        {FINANCIAL_SNAPSHOT.map((tile) => (
          <StatTile key={tile.id} label={tile.label} value={formatMoney(tile.amount)} chip={<MeasuredChip />} sub={tile.note} />
        ))}

        {overheadState.status === 'loading' && (
          <StatTile label="Registration cost unresolved" value="…" chip={<StatusPill label="Loading" tone="muted" />} />
        )}
        {overheadState.status === 'error' && (
          <StatTile
            label="Registration cost unresolved"
            value="—"
            chip={<StatusPill label="Unreachable" tone="bad" />}
            sub={overheadState.message}
          />
        )}
        {overheadState.status === 'loaded' && (
          <StatTile
            label="Registration cost unresolved"
            value={formatMoney(unresolvedTotal ?? '0.00')}
            chip={<StatusPill label="Live" tone="good" />}
            sub={
              unresolvedRates.length > 0
                ? `${unresolvedRates.length} of ${overheadState.data.length} registered units have no matching fleet truck id — see the overhead table for VINs.`
                : 'Every registered unit resolves to a fleet truck id.'
            }
          />
        )}
      </div>

      <h2 style={{ marginTop: '2rem' }}>Cost per truck — registration only</h2>
      <p style={{ color: 'var(--muted)', maxWidth: 640 }}>
        IRP + HVUT only. Financing, insurance and ELD are not included yet — a cost-per-truck figure that looks
        complete but isn&apos;t is worse than one that admits its scope.
      </p>
      {overheadState.status === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      {overheadState.status === 'error' && (
        <p role="alert" style={{ color: 'var(--bad)' }}>
          Could not load registration overhead: {overheadState.message}
        </p>
      )}
      {overheadState.status === 'loaded' && representative === null && (
        <p style={{ color: 'var(--muted)' }}>No registration overhead has been posted yet.</p>
      )}
      {overheadState.status === 'loaded' && representative !== null && (
        <div className="stat-grid">
          <StatTile
            label="Annual (allocated)"
            value={formatMoney(representative.annualTotal)}
            chip={<StatusPill label="Allocated" tone="warn" />}
          />
          <StatTile
            label="Monthly (posted)"
            value={formatMoney(representative.monthlyLedger)}
            chip={<StatusPill label="Live" tone="good" />}
          />
          <StatTile
            label="Weekly (analysis)"
            value={formatRate(representative.weeklyRate)}
            chip={<StatusPill label="Never posted" tone="muted" />}
          />
          <StatTile
            label="Daily (analysis)"
            value={formatRate(representative.dailyRate)}
            chip={<StatusPill label="Never posted" tone="muted" />}
          />
        </div>
      )}
    </div>
  );
}
