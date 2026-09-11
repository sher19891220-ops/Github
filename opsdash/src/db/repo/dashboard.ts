/**
 * What the landing screen actually reads.
 *
 * Until now every money tile on the front page was `isLive: false` — a
 * figure quoted from a test or a doc, correctly labelled, and still the
 * first thing anyone saw every morning. This replaces them with figures
 * that come off the database at the moment the page is asked for.
 *
 * The rule that shapes every query here: **an empty database renders as
 * "nothing yet", never as zero.** `$0.00 revenue` is a claim that the
 * fleet earned nothing; `—` is the truth, which is that nothing has been
 * posted. So each figure carries the count of rows behind it, and the
 * screen keys off the count, not the amount. A fleet genuinely having a
 * zero month and a fleet whose data has not arrived must never render the
 * same way.
 */
import { query } from '@/db/pool';
import type { Decimal } from '@/contract/types';
import { quarterOf } from './ifta';

export interface LiveFigure {
  amount: Decimal;
  /** How many ledger rows produced this. Zero means nothing has been
   *  posted, which the screen renders differently from a zero amount. */
  entryCount: number;
}

export interface DashboardWorkItem {
  id: string;
  label: string;
  count: number;
  href: string | null;
  note: string | null;
}

export interface DashboardResponse {
  from: string;
  to: string;
  revenue: LiveFigure;
  companyCost: LiveFigure;
  margin: Decimal;
  /** Owed between the group's own entities. Netted to one side: a
   *  receivable and its matching payable are the same money seen twice. */
  intercompanyReceivable: LiveFigure;
  /** Cost borne by drivers and owed back to the company. Never counted as
   *  company cost — treating it as one understates the company twice. */
  driverReceivable: LiveFigure;
  workQueue: DashboardWorkItem[];
  /** True when nothing at all has been posted in this window. */
  isEmpty: boolean;
}

/**
 * `COALESCE(sum(...), 0)::text` renders as `"0"`, not `"0.00"` — money on
 * the wire is always `numeric(14,2)`, and the UI's money formatter and
 * `moneyToCents` both expect that shape. The cast is in the SQL; this
 * guard catches any query that forgets it rather than letting a bare "0"
 * reach a screen.
 */
function figure(rows: Array<{ total: string | null; n: string }>): LiveFigure {
  const row = rows[0];
  const raw = row?.total ?? '0.00';
  return { amount: /\.\d{2}$/.test(raw) ? raw : `${raw}.00`, entryCount: Number(row?.n ?? 0) };
}

export async function getDashboard(from: string, to: string): Promise<DashboardResponse> {
  const [revenue, cost, intercompany, driverBorne] = await Promise.all([
    query<{ total: string | null; n: string }>(
      `SELECT COALESCE(sum(l.amount), 0)::numeric(14,2)::text AS total, count(*) AS n
         FROM accounting.ledger_entry l
         JOIN accounting.category c ON c.category_id = l.category_id
        WHERE c.category_group = 'revenue'
          AND l.accrual_date BETWEEN $1::date AND $2::date`,
      [from, to],
    ),
    // Company cost only: driver-borne rows are a receivable, not a cost,
    // and balance-sheet movements are money changing shape rather than
    // money spent. Both are excluded here and surfaced separately.
    query<{ total: string | null; n: string }>(
      `SELECT COALESCE(sum(l.amount), 0)::numeric(14,2)::text AS total, count(*) AS n
         FROM accounting.ledger_entry l
         JOIN accounting.category c ON c.category_id = l.category_id
        WHERE c.category_group <> 'revenue'
          AND c.account_nature = 'pnl'
          AND l.charged_to = 'company'
          AND l.accrual_date BETWEEN $1::date AND $2::date`,
      [from, to],
    ),
    query<{ total: string | null; n: string }>(
      `SELECT COALESCE(sum(l.amount), 0)::numeric(14,2)::text AS total, count(*) AS n
         FROM accounting.ledger_entry l
        WHERE l.category_id = 'receivable.intercompany'
          AND l.accrual_date BETWEEN $1::date AND $2::date`,
      [from, to],
    ),
    query<{ total: string | null; n: string }>(
      `SELECT COALESCE(sum(abs(l.amount)), 0)::numeric(14,2)::text AS total, count(*) AS n
         FROM accounting.ledger_entry l
        WHERE l.charged_to = 'driver'
          AND l.accrual_date BETWEEN $1::date AND $2::date`,
      [from, to],
    ),
  ]);

  const rev = figure(revenue);
  const cst = figure(cost);
  const marginCents = centsOf(rev.amount) + centsOf(cst.amount); // cost is already negative
  const workQueue = await getWorkQueue(to);

  return {
    from,
    to,
    revenue: rev,
    companyCost: cst,
    margin: moneyOf(marginCents),
    intercompanyReceivable: figure(intercompany),
    driverReceivable: figure(driverBorne),
    workQueue,
    isEmpty: rev.entryCount === 0 && cst.entryCount === 0,
  };
}

/**
 * Everything waiting on a person, largest first.
 *
 * Every row here is a real count from a real table, and every one links to
 * the screen that resolves it. A queue item nobody can act on is not a
 * queue item — it is a fact, and it belongs somewhere else on the page.
 */
async function getWorkQueue(asOf: string): Promise<DashboardWorkItem[]> {
  const q = quarterOf(asOf);

  const [chargeback, underReview, failedParse, noStatus, missingRates] = await Promise.all([
    query<{ n: string }>(
      `SELECT count(*) AS n FROM accounting.ledger_entry WHERE charged_to = 'unknown'`,
    ),
    query<{ n: string }>(
      `SELECT count(*) AS n FROM accounting.staging_row WHERE status = 'under_review'`,
    ),
    query<{ n: string }>(
      `SELECT count(*) AS n FROM accounting.source_document WHERE parse_status = 'failed'`,
    ),
    query<{ n: string }>(
      `SELECT count(*) AS n
         FROM accounting.truck t
        WHERE t.is_active
          AND NOT EXISTS (SELECT 1 FROM accounting.v_truck_status_current s WHERE s.truck_id = t.truck_id)`,
    ),
    // Jurisdictions this quarter's mileage reports cover that have no rate
    // on file. Each one is a line the IFTA engine withholds, so the return
    // is knowably short until somebody enters them.
    query<{ n: string }>(
      `SELECT count(DISTINCT s.jurisdiction) AS n
         FROM accounting.staging_row s
         JOIN accounting.source_document d ON d.document_id = s.document_id
        WHERE d.doc_type = 'ifta_mileage'
          AND s.status <> 'rejected'
          AND s.jurisdiction IS NOT NULL
          AND (s.parsed_payload->>'periodEnd') BETWEEN $1 AND $2
          AND NOT EXISTS (
            SELECT 1 FROM accounting.ifta_rate r
             WHERE r.jurisdiction = s.jurisdiction
               AND r.period_year = $3 AND r.period_quarter = $4 AND r.fuel_type = 'diesel')`,
      [quarterStart(q), asOf, q.year, q.quarter],
    ),
  ]);

  const items: DashboardWorkItem[] = [
    {
      id: 'chargeback-pending',
      label: 'Chargeback decisions pending',
      count: Number(chargeback[0]?.n ?? 0),
      href: '/chargeback',
      note: 'Cost rows charged to nobody yet — excluded from both company cost and the driver receivable until decided.',
    },
    {
      id: 'rows-under-review',
      label: 'Staged rows needing review',
      count: Number(underReview[0]?.n ?? 0),
      href: '/review',
      note: null,
    },
    {
      id: 'documents-failed',
      label: 'Documents that failed to parse',
      count: Number(failedParse[0]?.n ?? 0),
      href: '/documents',
      note: 'The bytes are stored; nothing was read from them.',
    },
    {
      id: 'trucks-no-status',
      label: 'Active trucks with no status on file',
      count: Number(noStatus[0]?.n ?? 0),
      href: '/fleet',
      note: 'Absent, not available — a truck with no status is never counted as ready.',
    },
    {
      id: 'ifta-missing-rates',
      label: `States driven with no ${q.year} Q${q.quarter} IFTA rate`,
      count: Number(missingRates[0]?.n ?? 0),
      href: '/ifta',
      note: 'Each one is a line withheld from the return, so the total is short until the rate is entered.',
    },
  ];

  return items.filter((i) => i.count > 0).sort((a, b) => b.count - a.count);
}

function quarterStart(q: { year: number; quarter: number }): string {
  const month = (q.quarter - 1) * 3 + 1;
  return `${q.year}-${String(month).padStart(2, '0')}-01`;
}

/* Exact cents, same convention as everywhere else money is handled. */
function centsOf(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return 0n;
  const abs = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -abs : abs;
}

function moneyOf(cents: bigint): Decimal {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg && abs !== 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
