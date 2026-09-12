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
const ENTITIES: Array<{ code: string; legalName: string; base: string | null }> = [
  { code: 'ZONE', legalName: 'Zone OH LLC', base: 'OH' },
  { code: 'XTRACK', legalName: 'Xtrack LLC', base: 'IL' },
  { code: 'AFG', legalName: 'AFG Logistics LLC', base: null },
  { code: 'IRONLEASE', legalName: 'Iron Lease LLC', base: null },
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
      `INSERT INTO accounting.entity (code, legal_name, ifta_base_jurisdiction)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE
         SET legal_name = EXCLUDED.legal_name,
             ifta_base_jurisdiction = COALESCE(EXCLUDED.ifta_base_jurisdiction, accounting.entity.ifta_base_jurisdiction)`,
      [e.code, e.legalName, e.base],
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
  const known = new Set(CATEGORIES.map(([id]) => id));
  const missing = suggestableCategories().filter((c) => !known.has(c));
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
