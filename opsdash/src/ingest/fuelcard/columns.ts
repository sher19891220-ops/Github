/**
 * Which column means what.
 *
 * Every fuel-card vendor emits the same handful of *facts* — when, which
 * truck, where, what product, how many gallons, at what price, for how much
 * — under different column names, in different orders, with different
 * extras. EFS, Relay, WEX and Comdata all differ, the same vendor differs
 * between its CSV export and its PDF invoice, and the operator uses more
 * than one.
 *
 * So columns are matched by *meaning*, never by position. The alternative —
 * a fixed layout per vendor — is a guess that breaks silently the first
 * time a vendor adds a column, and breaks by shifting every field to the
 * right of the insertion rather than by failing.
 *
 * Two mappings are deliberate and easy to get backwards:
 *
 * **Transaction date beats post date.** A statement usually carries both.
 * The post date is when the card company booked it; the transaction date is
 * when the fuel went into the tank. IFTA and the accrual both want the
 * latter, and near a quarter boundary the two answer different quarters —
 * a purchase on 31 March posting on 2 April belongs in Q1 and would file in
 * Q2. Ranked, not guessed.
 *
 * **Net amount beats gross amount.** Card statements commonly show a retail
 * price, a discount, and what was actually billed. The company's cost is
 * what was billed. Taking the gross overstates fuel cost by the whole
 * discount, on every line, and the discount is the reason the card exists.
 */

export type ColumnRole =
  | 'transactionDate'
  | 'postDate'
  | 'unit'
  | 'driver'
  | 'cardNumber'
  | 'invoice'
  | 'location'
  | 'city'
  | 'state'
  | 'product'
  | 'quantity'
  | 'unitPrice'
  | 'amountNet'
  | 'amountGross'
  | 'discount';

interface RoleSpec {
  role: ColumnRole;
  /** Tried in order; an earlier pattern is a better match than a later one. */
  patterns: RegExp[];
}

/**
 * Matched against the *normalised* header (lowercased, punctuation and
 * runs of whitespace collapsed). Patterns are anchored where a loose match
 * would steal another role's column — `^amount$` rather than `amount`, so
 * "discount amount" does not win the amount role.
 */
const SPECS: readonly RoleSpec[] = [
  {
    role: 'transactionDate',
    patterns: [
      /^(tran|trans|transaction|purchase|sale|fuel)\s*date$/,
      /^date\s*of\s*(purchase|sale|transaction)$/,
      /^(tran|trans|txn)\s*dt$/,
      /^date$/,
    ],
  },
  {
    role: 'postDate',
    patterns: [/^(post|posting|billing|bill|invoice|process(ed)?)\s*date$/, /^post\s*dt$/],
  },
  {
    role: 'unit',
    patterns: [
      /^(unit|vehicle|truck|tractor|asset)\s*(number|num|no|nbr|id|#)?$/,
      /^(veh|unt|trk)\s*#?$/,
      /^equipment\s*(number|id|#)?$/,
    ],
  },
  {
    role: 'driver',
    patterns: [/^driver\s*(name|id|number|#)?$/, /^(employee|operator)\s*(name|id)?$/, /^name$/],
  },
  {
    role: 'cardNumber',
    patterns: [/^card\s*(number|num|no|#)?$/, /^(account|acct)\s*(number|no|#)$/, /^pan$/],
  },
  {
    role: 'invoice',
    patterns: [
      /^(invoice|inv|reference|ref|transaction|tran|trans|txn|receipt|ticket)\s*(number|num|no|id|#)$/,
      /^(invoice|inv|ref|txn)\s*#?$/,
      /^auth\s*(code|number|#)?$/,
    ],
  },
  {
    role: 'location',
    patterns: [
      /^(location|site|merchant|truckstop|truck\s*stop|station|vendor|seller)\s*(name|address)?$/,
      /^(loc|merch)\s*(name|addr)?$/,
      /^address$/,
    ],
  },
  { role: 'city', patterns: [/^city$/, /^(loc|location|site|merchant)\s*city$/, /^town$/] },
  {
    role: 'state',
    patterns: [
      /^(state|st|prov|province|jurisdiction)$/,
      /^(loc|location|site|merchant|purchase|fuel)\s*(state|st)$/,
      /^state\s*(code|abbr)$/,
    ],
  },
  {
    role: 'product',
    patterns: [
      /^(product|item|fuel|service|description|desc|category|type)\s*(name|type|code|description)?$/,
      /^(prod|itm)\s*(cd|code|desc)?$/,
      /^fuel\s*grade$/,
    ],
  },
  {
    role: 'quantity',
    patterns: [
      /^(quantity|qty|gallons|gals?|units?|volume)$/,
      /^(fuel\s*)?(quantity|qty|gallons|gals?)$/,
      /^qty\s*(purchased|sold)?$/,
    ],
  },
  {
    role: 'unitPrice',
    patterns: [
      /^(unit\s*)?(price|cost|ppu|ppg)$/,
      /^price\s*(per\s*)?(gal|gallon|unit)$/,
      /^(net|billed)\s*(unit\s*)?price$/,
      /^(retail|posted|pump)\s*price$/,
    ],
  },
  {
    role: 'amountNet',
    patterns: [
      /^(net|billed|invoice[d]?|charged?|your)\s*(amount|amt|cost|total|price)$/,
      /^amount\s*(billed|charged|due)$/,
      /^(net|total)\s*\$?$/,
      /^amount$/,
      /^amt$/,
      /^total$/,
    ],
  },
  {
    role: 'amountGross',
    patterns: [
      /^(gross|retail|posted|pump|list)\s*(amount|amt|cost|total|price)$/,
      /^amount\s*before\s*discount$/,
    ],
  },
  {
    role: 'discount',
    patterns: [/^(discount|savings|saved|rebate)\s*(amount|amt|\$)?$/, /^disc$/],
  },
];

/** Lowercases, strips punctuation the vendors sprinkle around, collapses
 *  whitespace. `"Tran. Date"`, `"TRAN_DATE"` and `"Tran Date"` all become
 *  `"tran date"`. */
export function normalizeHeader(cell: string): string {
  return cell
    .toLowerCase()
    .replace(/[._*]+/g, ' ')
    .replace(/[():]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ColumnMap = Partial<Record<ColumnRole, number>>;

export interface MappingResult {
  map: ColumnMap;
  /** Header cells no role claimed, as printed. Reported so an operator can
   *  see what the parser ignored rather than wondering. */
  unmapped: string[];
  /** Roles matched by more than one column, with the columns that tied.
   *  The first is used; the collision is reported rather than hidden. */
  ambiguous: Array<{ role: ColumnRole; headers: string[] }>;
}

/**
 * Assigns roles to columns.
 *
 * A column wins a role by its *best* pattern rank, and each column takes at
 * most one role, so a header like `Tran Date` cannot satisfy both
 * `transactionDate` and `postDate`. Ties are resolved leftward and
 * reported.
 */
export function mapColumns(header: readonly string[]): MappingResult {
  const normalized = header.map(normalizeHeader);

  // role -> candidate columns, best rank first
  const candidates = new Map<ColumnRole, Array<{ index: number; rank: number }>>();
  // column -> its best (role, rank), so one column never fills two roles
  const claimed = new Map<number, { role: ColumnRole; rank: number }>();

  for (const spec of SPECS) {
    for (let i = 0; i < normalized.length; i += 1) {
      const cell = normalized[i]!;
      if (cell === '') continue;
      const rank = spec.patterns.findIndex((p) => p.test(cell));
      if (rank === -1) continue;

      const existing = claimed.get(i);
      if (existing === undefined || rank < existing.rank) {
        claimed.set(i, { role: spec.role, rank });
      }
      const list = candidates.get(spec.role) ?? [];
      list.push({ index: i, rank });
      candidates.set(spec.role, list);
    }
  }

  const map: ColumnMap = {};
  const ambiguous: MappingResult['ambiguous'] = [];

  for (const [role, list] of candidates) {
    // Only columns whose own best role is this one.
    const owned = list.filter((c) => claimed.get(c.index)?.role === role);
    if (owned.length === 0) continue;
    owned.sort((a, b) => a.rank - b.rank || a.index - b.index);
    map[role] = owned[0]!.index;
    if (owned.length > 1) {
      ambiguous.push({ role, headers: owned.map((c) => header[c.index] ?? '') });
    }
  }

  const usedIndexes = new Set(Object.values(map));
  const unmapped = header.filter((h, i) => h.trim() !== '' && !usedIndexes.has(i));

  return { map, unmapped, ambiguous };
}

/**
 * How much this row looks like a header rather than data. Used by
 * `readTable` to find where the transaction table starts, under the
 * letterhead every real statement opens with.
 */
export function headerScore(cells: readonly string[]): number {
  const { map } = mapColumns(cells);
  const roles = Object.keys(map).length;
  if (roles < 3) return 0;

  // A data row can accidentally match a couple of patterns. A header is
  // also overwhelmingly non-numeric.
  const nonEmpty = cells.filter((c) => c.trim() !== '');
  if (nonEmpty.length === 0) return 0;
  const numeric = nonEmpty.filter((c) => /^[-+$(]?[\d,]+(\.\d+)?\)?$/.test(c.trim())).length;
  if (numeric / nonEmpty.length > 0.4) return 0;

  return roles;
}

/**
 * The roles without which a statement line cannot become a ledger row.
 *
 * A date is required, but either kind will do: a statement carrying only a
 * post date is worse than one carrying a transaction date and is still
 * usable — the difference is reported as a problem rather than refusing the
 * whole document. Likewise an amount: gross-only is worse than net and is
 * still money.
 */
export const REQUIRED_ROLES: readonly ColumnRole[] = ['transactionDate', 'amountNet'];

const EITHER_OF: ReadonlyArray<readonly ColumnRole[]> = [
  ['transactionDate', 'postDate'],
  ['amountNet', 'amountGross'],
];

export function missingRequiredRoles(map: ColumnMap): ColumnRole[] {
  const missing: ColumnRole[] = [];
  for (const group of EITHER_OF) {
    if (group.every((role) => map[role] === undefined)) missing.push(group[0]!);
  }
  return missing;
}
