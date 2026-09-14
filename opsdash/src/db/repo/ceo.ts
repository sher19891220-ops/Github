/**
 * The CEO view: every entity's position, every truck's, and next week.
 *
 * Three things on one screen, and the third is the one that can do damage.
 * The build contract is blunt about it: *"A forecast rendered like an
 * actual is the single worst failure this dashboard can have."* So the
 * forecast is a separate shape in the response, never merged into the
 * roll-up, and it carries its own back-test so the screen can show how
 * wrong the method has been rather than a bare confident line.
 *
 * The truck list is deliberately ordered worst-first. A profitable-truck
 * list sorted best-first is a reassurance; the useful question is which
 * units are losing money this month.
 */
import { query } from '@/db/pool';
import type { Decimal } from '@/contract/types';
import { calculateForecast, type ForecastResult, type WeekActual } from '@/engines/forecast';

export interface EntityPosition {
  entityId: string;
  code: string;
  legalName: string;
  revenue: Decimal;
  companyCost: Decimal;
  /** Null when there is revenue but no cost, or cost but no revenue. See
   *  `marginOf` — a margin equal to revenue is the most misleading figure
   *  either dashboard can show. */
  margin: Decimal | null;
  entryCount: number;
}

export interface TruckPosition {
  truckId: string;
  unitNumber: string;
  entityCode: string | null;
  revenue: Decimal;
  companyCost: Decimal;
  margin: Decimal | null;
  entryCount: number;
}

export interface CeoResponse {
  from: string;
  to: string;
  entities: EntityPosition[];
  group: {
    revenue: Decimal;
    companyCost: Decimal;
    margin: Decimal | null;
    marginBlocked: string | null;
    entryCount: number;
  };
  /** Worst margin first. Trucks with no ledger activity are absent, not
   *  listed at zero — a truck nobody posted anything for has no margin,
   *  which is different from breaking even. */
  trucks: TruckPosition[];
  forecast: ForecastResult;
  problems: string[];
}

/**
 * Revenue less cost — or null, when one side of the subtraction has no
 * entries behind it at all.
 *
 * The first end-to-end run on real files is why this exists. A year of
 * real dispatch revenue posted while every cost row sat in staging, and
 * this view's headline read "Group margin $2,336,117.36" — which was
 * revenue, exactly, to the cent. Arithmetically correct and the worst
 * number on the page.
 *
 * Withholding it is not a display nicety. Revenue-as-margin is the figure
 * most likely to be quoted in a meeting, and it is indistinguishable from
 * a real margin unless something refuses to print it.
 */
function marginOf(revenueCents: bigint, costCents: bigint, revenueRows: number, costRows: number): {
  margin: Decimal | null;
  blocked: string | null;
} {
  if (revenueRows === 0 && costRows === 0) {
    return { margin: null, blocked: 'Nothing has been posted in this period.' };
  }
  if (costRows === 0) {
    return {
      margin: null,
      blocked:
        'No cost has been posted in this period, so revenue less cost would just be revenue. Withheld rather than shown equal to revenue.',
    };
  }
  if (revenueRows === 0) {
    return {
      margin: null,
      blocked: 'No revenue has been posted in this period, so this would show cost as a loss with nothing earned against it.',
    };
  }
  return { margin: money(revenueCents + costCents), blocked: null };
}

const MONEY_SUM = `COALESCE(sum(CASE WHEN c.category_group = 'revenue' THEN l.amount ELSE 0 END), 0)::numeric(14,2)::text`;
const COST_SUM = `COALESCE(sum(CASE WHEN c.category_group <> 'revenue' AND c.account_nature = 'pnl' AND l.charged_to = 'company' THEN l.amount ELSE 0 END), 0)::numeric(14,2)::text`;

export async function getCeoView(from: string, to: string): Promise<CeoResponse> {
  const problems: string[] = [];

  const entityRows = await query<{
    entity_id: string; code: string; legal_name: string;
    revenue: string; cost: string; n: string; rev_n: string; cost_n: string;
  }>(
    `SELECT e.entity_id, e.code, e.legal_name,
            ${MONEY_SUM} AS revenue, ${COST_SUM} AS cost, count(l.entry_id) AS n,
            count(l.entry_id) FILTER (WHERE c.category_group = 'revenue') AS rev_n,
            count(l.entry_id) FILTER (WHERE c.category_group <> 'revenue' AND c.account_nature = 'pnl' AND l.charged_to = 'company') AS cost_n
       FROM accounting.entity e
       LEFT JOIN accounting.ledger_entry l
              ON l.entity_id = e.entity_id AND l.accrual_date BETWEEN $1::date AND $2::date
       LEFT JOIN accounting.category c ON c.category_id = l.category_id
      WHERE e.is_active
      GROUP BY e.entity_id, e.code, e.legal_name
      ORDER BY e.code`,
    [from, to],
  );

  const entities: EntityPosition[] = entityRows.map((r) => ({
    entityId: r.entity_id,
    code: r.code,
    legalName: r.legal_name,
    revenue: r.revenue,
    companyCost: r.cost,
    margin: marginOf(cents(r.revenue), cents(r.cost), Number(r.rev_n), Number(r.cost_n)).margin,
    entryCount: Number(r.n),
  }));

  // Summed from the entity rows rather than re-queried: two queries that
  // ought to agree are two queries that can disagree, and a group total
  // that does not equal its own parts is the fastest way to lose a
  // reader's trust in every other figure on the page.
  const groupRevenueCents = entities.reduce((a, e) => a + cents(e.revenue), 0n);
  const groupCostCents = entities.reduce((a, e) => a + cents(e.companyCost), 0n);
  const groupRevRows = entityRows.reduce((a, r) => a + Number(r.rev_n), 0);
  const groupCostRows = entityRows.reduce((a, r) => a + Number(r.cost_n), 0);
  const groupMargin = marginOf(groupRevenueCents, groupCostCents, groupRevRows, groupCostRows);

  const group = {
    revenue: money(groupRevenueCents),
    companyCost: money(groupCostCents),
    margin: groupMargin.margin,
    marginBlocked: groupMargin.blocked,
    entryCount: entities.reduce((a, e) => a + e.entryCount, 0),
  };

  const truckRows = await query<{
    truck_id: string; unit_number: string; code: string | null;
    revenue: string; cost: string; n: string; rev_n: string; cost_n: string;
  }>(
    `SELECT t.truck_id, t.unit_number, max(e.code) AS code,
            ${MONEY_SUM} AS revenue, ${COST_SUM} AS cost, count(l.entry_id) AS n,
            count(l.entry_id) FILTER (WHERE c.category_group = 'revenue') AS rev_n,
            count(l.entry_id) FILTER (WHERE c.category_group <> 'revenue' AND c.account_nature = 'pnl' AND l.charged_to = 'company') AS cost_n
       FROM accounting.truck t
       JOIN accounting.ledger_entry l
              ON l.truck_id = t.truck_id AND l.accrual_date BETWEEN $1::date AND $2::date
       JOIN accounting.category c ON c.category_id = l.category_id
       LEFT JOIN accounting.entity e ON e.entity_id = l.entity_id
      GROUP BY t.truck_id, t.unit_number
      ORDER BY (${MONEY_SUM})::numeric + (${COST_SUM})::numeric ASC`,
    [from, to],
  );

  const trucks: TruckPosition[] = truckRows.map((r) => ({
    truckId: r.truck_id,
    unitNumber: r.unit_number,
    entityCode: r.code,
    revenue: r.revenue,
    companyCost: r.cost,
    margin: marginOf(cents(r.revenue), cents(r.cost), Number(r.rev_n), Number(r.cost_n)).margin,
    entryCount: Number(r.n),
  }));

  const unassigned = await query<{ n: string }>(
    `SELECT count(*) AS n FROM accounting.ledger_entry l
       JOIN accounting.category c ON c.category_id = l.category_id
      WHERE l.truck_id IS NULL AND c.account_nature = 'pnl'
        AND l.accrual_date BETWEEN $1::date AND $2::date`,
    [from, to],
  );
  const unassignedCount = Number(unassigned[0]?.n ?? 0);
  if (unassignedCount > 0) {
    problems.push(
      `${unassignedCount} P&L entries in this period carry no truck, so they are in the entity totals above but in no truck's line. ` +
        'The per-truck margins therefore add up to less than the group margin, by design rather than by error.',
    );
  }

  const forecast = await getForecast(to);

  return { from, to, entities, group, trucks, forecast, problems };
}

/**
 * Next week, from the closed weeks before it.
 *
 * "Closed" here means the week ended before the as-of date. A week still
 * in progress must never enter the history: a partial week looks like a
 * catastrophic one, and a moving average that swallows it drags every
 * subsequent forecast down for a month.
 */
async function getForecast(asOf: string): Promise<ForecastResult> {
  const lastMonday = mondayOf(asOf);
  // 16 weeks back gives 12 back-test points on a 4-week window.
  const historyStart = addDays(lastMonday, -7 * 16);
  const historyEnd = addDays(lastMonday, -1);

  const rows = await query<{ week_start: string; revenue: string; cost: string }>(
    `SELECT to_char(date_trunc('week', l.accrual_date), 'YYYY-MM-DD') AS week_start,
            ${MONEY_SUM} AS revenue, ${COST_SUM} AS cost
       FROM accounting.ledger_entry l
       JOIN accounting.category c ON c.category_id = l.category_id
      WHERE l.accrual_date BETWEEN $1::date AND $2::date
      GROUP BY date_trunc('week', l.accrual_date)
      ORDER BY date_trunc('week', l.accrual_date)`,
    [historyStart, historyEnd],
  );

  const history: WeekActual[] = rows.map((r) => ({
    periodStart: r.week_start,
    periodEnd: addDays(r.week_start, 6),
    revenue: r.revenue,
    cost: r.cost,
    margin: money(cents(r.revenue) + cents(r.cost)),
  }));

  return calculateForecast(history, lastMonday, addDays(lastMonday, 6));
}

/* --------------------------------------------------------------------- */

function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(iso, -back);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function cents(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return 0n;
  const abs = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -abs : abs;
}

function money(c: bigint): Decimal {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg && abs !== 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
