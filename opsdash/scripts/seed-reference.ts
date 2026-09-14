/**
 * The reference data an operator must have before the first upload.
 *
 * Found by doing the first real end-to-end run: a clean database has no
 * entities and a chart of accounts covering only what the registration
 * migrations needed. The first dispatch upload resolves its entity markers
 * through `source_key_map` and finds nothing; the first expense row has
 * nowhere to be categorised to. Neither failure says "you have not set the
 * system up yet", because nothing had ever run on a genuinely empty
 * database before.
 *
 * So this is part of deploying, not part of testing. It is idempotent —
 * safe to re-run — and it creates nothing that is a business figure: only
 * the names of the companies and the categories costs get filed under.
 *
 *   npx tsx scripts/seed-reference.ts
 */
import { query } from '../src/db/pool';

/** The operating companies. Iron Lease holds title to trucks and does not
 *  operate them, so it is an entity for ownership purposes and never a
 *  recharge target — see docs/SOURCE-DISCOVERY.md §11e. */
const ENTITIES: Array<{ code: string; legalName: string; base: string | null; kind: 'carrier' | 'shop' | 'asset_holder' }> = [
  { code: 'ZONE', legalName: 'Zone OH LLC', base: 'OH', kind: 'carrier' },
  { code: 'XTRACK', legalName: 'Xtrack LLC', base: 'IL', kind: 'carrier' },
  { code: 'AFG', legalName: 'AFG Logistics LLC', base: null, kind: 'carrier' },
  { code: 'IRONLEASE', legalName: 'Iron Lease LLC', base: null, kind: 'asset_holder' },
  // The shop was missing entirely. It bills the carriers for repairs, so
  // leaving it out meant every repair was a cost to a carrier and revenue to
  // nobody — the group's cost overstated by the shop's markup, and the shop
  // with no P&L at all.
  { code: 'TRUCKMAX', legalName: 'Truck Max LLC', base: null, kind: 'shop' },
];

/**
 * The chart of accounts.
 *
 * `sign` is +1 where a positive amount increases margin and -1 where it
 * decreases it. It is not cosmetic: it is how a screen knows whether a
 * figure is money in or money out without inferring direction from the
 * category's name, which is how a cost eventually renders as revenue.
 */
const CATEGORIES: Array<[id: string, group: string, name: string, sign: number]> = [
  ['revenue.linehaul', 'revenue', 'Linehaul revenue', 1],
  ['revenue.accessorial', 'revenue', 'Detention, layover and accessorials', 1],
  ['fuel.diesel', 'fuel', 'Diesel', -1],
  ['fuel.def', 'fuel', 'DEF', -1],
  ['fuel.reefer', 'fuel', 'Reefer fuel', -1],
  ['toll.ezpass', 'toll', 'Tolls', -1],
  ['toll.violation', 'toll', 'Toll violations and fines', -1],
  ['maintenance.repair', 'maintenance', 'Repairs', -1],
  ['maintenance.tires', 'maintenance', 'Tires', -1],
  ['maintenance.pm', 'maintenance', 'Preventive maintenance', -1],
  ['maintenance.roadside', 'maintenance', 'Roadside service', -1],
  // Added from the real expenses export rather than from imagination:
  // washing and detailing is 93 rows and $18,277, and consumables
  // (straps, chains, mudflaps) another 137 rows and $36,416. Filing
  // either under "repairs" would make that category mean nothing.
  ['maintenance.wash', 'maintenance', 'Washing and detailing', -1],
  // Trailers are pooled across the carriers — 47% of those with enough cost
  // history were pulled by trucks from more than one company — so their
  // upkeep is not any one truck's variable cost. It is fixed cost, carried
  // as a single line rather than split across the maintenance categories,
  // because nothing downstream should be tempted to divide it by a truck.
  ['trailer.fixed', 'trailer', 'Trailer cost (fixed)', -1],
  // The rest of the fixed cost the operator already tracks per truck per week
  // ("Fixed costs by company"). The chart had nowhere to put salaries, and
  // insurance was a single line when the sheet carries three.
  ['insurance.physical_damage', 'insurance', 'Physical damage insurance', -1],
  ['insurance.occupational', 'insurance', 'Occupational accident insurance', -1],
  ['overhead.salaries', 'overhead', 'Office salaries', -1],
  ['overhead.software', 'overhead', 'Software and subscriptions', -1],
  ['overhead.recruiting', 'overhead', 'Recruiting and driver compliance', -1],
  ['overhead.travel', 'overhead', 'Travel (driver relocation)', -1],
  ['maintenance.supplies', 'maintenance', 'Consumables and fittings', -1],
  ['ifta.tax', 'ifta', 'IFTA fuel tax', -1],
  ['ifta.weight_distance', 'ifta', 'Weight-distance tax (NY/KY/NM/OR)', -1],
  ['insurance.liability', 'insurance', 'Liability and cargo insurance', -1],
  ['driver_pay.settlement', 'driver_pay', 'Driver settlements', -1],
  ['lease.truck', 'lease', 'Truck lease and financing', -1],
  ['other_cost.eld', 'other_cost', 'ELD and telematics', -1],
  ['other_cost.factoring_fee', 'other_cost', 'Factoring fees', -1],
  ['other_cost.parking', 'other_cost', 'Parking, yard and storage', -1],
];

async function main(): Promise<void> {
  for (const e of ENTITIES) {
    await query(
      `INSERT INTO accounting.entity (code, legal_name, ifta_base_jurisdiction, kind)
       VALUES ($1, $2, $3, $4::accounting.entity_kind)
       ON CONFLICT (code) DO UPDATE
         SET legal_name = EXCLUDED.legal_name,
             ifta_base_jurisdiction = COALESCE(EXCLUDED.ifta_base_jurisdiction, accounting.entity.ifta_base_jurisdiction),
             kind = EXCLUDED.kind`,
      [e.code, e.legalName, e.base, e.kind],
    );
  }

  for (const [id, group, name, sign] of CATEGORIES) {
    await query(
      `INSERT INTO accounting.category (category_id, category_group, display_name, sign)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (category_id) DO UPDATE
         SET category_group = EXCLUDED.category_group, display_name = EXCLUDED.display_name`,
      [id, group, name, sign],
    );
  }

  // How the sheets write each company's name. The dispatch sheet marks
  // rows with a bare word; identity resolution goes through this map
  // rather than matching strings, because the same company is written
  // several ways and a string match is how one company's revenue lands on
  // another's P&L.
  const rows = await query<{ entity_id: string; code: string }>(
    `SELECT entity_id, code FROM accounting.entity`,
  );
  const byCode = new Map(rows.map((r) => [r.code, r.entity_id]));

  const MARKERS: Array<[system: string, key: string, code: string]> = [
    ['dispatch', 'ZONE', 'ZONE'],
    ['dispatch', 'XTRACK', 'XTRACK'],
    ['dispatch', 'AFG', 'AFG'],
    ['irp', 'ZONE-OH LLC', 'ZONE'],
    ['irp', 'XTRACK LLC', 'XTRACK'],
    // The expenses sheet's own vocabulary: its `Expense side` column says
    // "Xtrack exp" / "AFG exp", and its Details column a bare code. Its own
    // source system, so the same string from two sheets is never merged.
    ['expenses', 'zone', 'ZONE'],
    ['expenses', 'xtrack', 'XTRACK'],
    ['expenses', 'afg', 'AFG'],
  ];
  for (const [system, key, code] of MARKERS) {
    const id = byCode.get(code);
    if (!id) continue;
    await query(
      `INSERT INTO accounting.source_key_map (canonical_kind, canonical_id, source_system, source_key)
       VALUES ('entity', $1, $2, $3)
       ON CONFLICT (source_system, source_key, canonical_kind) DO NOTHING`,
      [id, system, key],
    );
  }

  // A rule that proposes a category the chart of accounts does not have
  // would fail at apply time, in front of the operator, after they had
  // already made the decision. Checked here instead.
  const { suggestableCategories } = await import('../src/engines/categorise/suggest');
  // `getCategoryGroups` proposes this one directly, by unit type rather than
  // through a description rule, so it is not in `suggestableCategories()` and
  // has to be checked alongside it.
  const { TRAILER_FIXED_CATEGORY } = await import('../src/db/repo/categorise');
  const known = new Set(CATEGORIES.map(([id]) => id));
  const missing = [...suggestableCategories(), TRAILER_FIXED_CATEGORY].filter((c) => !known.has(c));
  if (missing.length > 0) {
    throw new Error(
      `The categorisation rules can propose ${missing.join(', ')}, which this chart of accounts does not define.`,
    );
  }

  console.log(`  entities   : ${ENTITIES.length}`);
  console.log(`  categories : ${CATEGORIES.length}`);
  console.log(`  key map    : ${MARKERS.length} source markers`);
  console.log('\n  Reference data is in place. Uploads can now resolve an entity and a category.\n');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
