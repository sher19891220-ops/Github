'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getDashboard, getOverheadRates } from '../data/api';
import { errorMessageFor, loaded, loading, errored, type FetchState } from '../data/fetchState';
import type { TruckOverheadRate } from '../data/types';
import { formatMoney, formatRate, sumMoney } from '../format/decimal';
import { StatusPill } from '../StatusPill';
import type { DashboardResponse } from '@/db/repo/dashboard';

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

/**
 * A money tile whose figure came off the database just now.
 *
 * `entryCount` is what makes this honest. An empty ledger and a genuinely
 * zero month both produce `0.00`, and they mean completely different
 * things — "nothing has been posted" versus "the fleet earned nothing".
 * So the tile renders the count, not the amount, when nothing is behind
 * it: an em dash and a plain sentence rather than a confident zero.
 */
function LiveMoneyTile({
  label,
  figure,
  sub,
  tone,
}: {
  label: string;
  figure: { amount: string; entryCount: number };
  sub?: string;
  tone?: 'good' | 'bad';
}) {
  if (figure.entryCount === 0) {
    return (
      <StatTile
        label={label}
        value="—"
        chip={<StatusPill label="Nothing posted" tone="muted" />}
        sub="No ledger entries in this period. Not zero — nothing has arrived yet."
      />
    );
  }
  return (
    <StatTile
      label={label}
      value={
        <span style={tone ? { color: tone === 'bad' ? 'var(--bad)' : 'var(--good)' } : undefined}>
          {formatMoney(figure.amount)}
        </span>
      }
      chip={<StatusPill label="Live" tone="good" />}
      sub={sub ? `${sub} · ${figure.entryCount} entries` : `${figure.entryCount} entries`}
    />
  );
}

/**
 * The accounting lead's landing screen. Answers two questions in order:
 * what needs a decision today (a work queue, largest first, each row
 * linking to the screen that resolves it), and where the money stands
 * (stat tiles — a single value is not a chart, so no gauges here; see
 * `docs/FLEET-BOARD-SPEC.md` §3).
 *
 * **Every figure on this page is now live.** It used to be a set of
 * correctly-labelled static snapshots quoted from tests and docs — honest,
 * and still the first thing read every morning, which made it the wrong
 * place for a number nothing behind it could move. `GET /api/dashboard`
 * reads the ledger, the staging queue, the documents table and the IFTA
 * rate table at the moment the page is asked for.
 *
 * The work queue is now built from counts rather than from a written-down
 * list, which changes its behaviour in the way that matters: an item
 * disappears when its count reaches zero. A queue that still shows "713
 * chargeback decisions" after they have all been made is worse than no
 * queue at all.
 */
export function AccountingDashboard() {
  const [overheadState, setOverheadState] = useState<FetchState<TruckOverheadRate[]>>(loading());
  const [live, setLive] = useState<FetchState<DashboardResponse>>(loading());

  useEffect(() => {
    let cancelled = false;
    getDashboard()
      .then((d) => {
        if (!cancelled) setLive(loaded(d));
      })
      .catch((err) => {
        if (!cancelled) setLive(errored(errorMessageFor(err, 'Could not load the dashboard.')));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const unresolvedRates = overheadState.status === 'loaded' ? overheadState.data.filter((r) => r.truckId == null) : [];
  const unresolvedTotal = unresolvedRates.length > 0 ? sumMoney(unresolvedRates.map((r) => r.annualTotal)) : null;
  const representative = overheadState.status === 'loaded' ? (overheadState.data[0] ?? null) : null;

  return (
    <div>
      <h1>Accounting</h1>
      <p style={{ color: 'var(--muted)' }}>What needs a decision today, and where the money stands.</p>

      <h2 style={{ marginTop: '1.5rem' }}>What needs you today</h2>
      {live.status === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      {live.status === 'error' && (
        <p role="alert" style={{ color: 'var(--bad)' }}>
          {live.message}
        </p>
      )}
      {live.status === 'loaded' && live.data.workQueue.length === 0 && (
        <p style={{ color: 'var(--good)' }}>
          Nothing waiting. Every staged row is reviewed, every cost row is assigned, and every state driven
          this quarter has an IFTA rate on file.
        </p>
      )}
      {live.status === 'loaded' &&
        live.data.workQueue.map((item) => (
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

      <h2 style={{ marginTop: '2rem' }}>Where the money stands</h2>
      {live.status === 'loaded' && (
        <p style={{ color: 'var(--muted)', margin: '0 0 0.75rem' }}>
          {live.data.from} to {live.data.to}
        </p>
      )}
      <div className="stat-grid">
        {live.status === 'loaded' && (
          <>
            <LiveMoneyTile label="Revenue" figure={live.data.revenue} />
            <LiveMoneyTile label="Company cost" figure={live.data.companyCost} />
            {live.data.margin === null ? (
              // Withheld, with the reason. A margin equal to revenue is
              // the single most misleading figure this page can show.
              <StatTile
                label="Margin"
                value="—"
                chip={<StatusPill label="Withheld" tone="warn" />}
                sub={live.data.marginBlocked}
              />
            ) : (
              <StatTile
                label="Margin"
                value={
                  <span style={{ color: live.data.margin.startsWith('-') ? 'var(--bad)' : 'var(--good)' }}>
                    {formatMoney(live.data.margin)}
                  </span>
                }
                // A computable margin is not a finished one. On the first
                // real run the cost side was $57k against $2.34M of
                // revenue — a 97.6% margin, which no fleet has ever had.
                // The chip says which it is.
                chip={
                  live.data.unpostedCost.rowCount > 0 ? (
                    <StatusPill label="Incomplete" tone="warn" />
                  ) : (
                    <StatusPill label="Live" tone="good" />
                  )
                }
                sub={
                  live.data.unpostedCost.rowCount > 0
                    ? `${live.data.unpostedCost.rowCount} cost rows worth ${formatMoney(live.data.unpostedCost.amount)} are staged and not posted, so this margin is higher than the real one.`
                    : 'Revenue less company cost only'
                }
              />
            )}
            <LiveMoneyTile
              label="Intercompany receivable"
              figure={live.data.intercompanyReceivable}
              sub="Owed between the group's own entities"
            />
            <LiveMoneyTile
              label="Driver receivable"
              figure={live.data.driverReceivable}
              sub="Driver-borne cost owed back — never counted as company cost"
            />
          </>
        )}

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
