/**
 * Resolves a parser's raw entity signal to a canonical `entity_id`.
 *
 * The dispatch parser (src/ingest/dispatch/parse.ts) deliberately does not
 * do this itself — DATA-CONTRACT.md §3 requires identity resolution to go
 * through `source_key_map`, "never a string match", and that crosswalk is a
 * database concern the parser has no access to. This is that resolution
 * step, and it is exactly why it lives in the persistence layer rather than
 * in `src/ingest/**`.
 */

type QueryFn = (text: string, params?: readonly unknown[]) => Promise<unknown[]>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntityResolution =
  | { entityId: string; resolvedFrom: 'direct' | 'source_key_map' | 'truck_roster' }
  | { entityId: null; resolvedFrom: 'unresolved' };

/**
 * `raw` is whatever a parser put in `StagingRow.entityId`: either already a
 * canonical uuid (parsers that resolve nothing leave it `null`), or a raw
 * code the sheet wrote (`"XTRACK"`, `"AFG"`, `"ZONE"`) that must be looked up
 * — never matched directly against `entity.code`, which would itself be the
 * "string match" the contract forbids for anything but the crosswalk table.
 *
 * `sourceSystem` records which upstream vocabulary `raw` is written in
 * (`'dispatch'` for the free-text marker in the driver-name column), so the
 * same code string from two different sheets is never accidentally merged.
 */
export async function resolveEntityId(
  q: QueryFn,
  raw: string | null,
  sourceSystem: string,
): Promise<EntityResolution> {
  if (!raw) return { entityId: null, resolvedFrom: 'unresolved' };
  if (UUID_RE.test(raw)) return { entityId: raw, resolvedFrom: 'direct' };

  const rows = await q(
    `SELECT canonical_id FROM accounting.source_key_map
     WHERE canonical_kind = 'entity' AND source_system = $1 AND source_key = $2`,
    [sourceSystem, raw],
  );
  const row = rows[0] as { canonical_id: string } | undefined;
  if (row) return { entityId: row.canonical_id, resolvedFrom: 'source_key_map' };
  return { entityId: null, resolvedFrom: 'unresolved' };
}

/**
 * Resolves an entity from the truck that earned the money, when the sheet
 * did not say which company it was.
 *
 * Measured on the operator's real dispatch export: 1,386 revenue rows, and
 * only **64** carry a free-text company marker. The other 1,322 were
 * rejected at commit for a missing entity — 95% of a year's revenue unable
 * to reach the ledger, which makes every P&L built on it meaningless.
 *
 * All 1,322 carry a truck number, and all 82 distinct truck numbers appear
 * in the operator's own truck-to-entity roster. So the entity is not
 * missing, it is written down somewhere else.
 *
 * **A truck's carrier is a fact with a date on it.** Units move between the
 * carriers mid-year, and units leave altogether — returned to the vendor, or
 * an owner-operator who quits. The operator's own roster lists four units
 * under two companies with two different drivers, and every unit missing from
 * that roster turns out to have stopped earning before the sheet ends.
 *
 * So this does not read `source_key_map`, whose primary key
 * (source_system, source_key, canonical_kind) permits exactly one entity per
 * unit for all time. That shape is right for an identity crosswalk — "this
 * string names that thing" does not change — and wrong here. Attributing a
 * transferred truck's whole year to one carrier would misstate both carriers'
 * P&L in a direction no reviewer could see.
 *
 * `truck_entity_history` is effective-dated and has existed since migration
 * 001 for exactly this; migration 015 added the non-overlap constraint that
 * makes the lookup below a function rather than a race with the query planner.
 *
 * The unit number still resolves through `truck`, so this is identity
 * resolution and not a string match against a carrier name.
 *
 * The caller marks rows resolved this way for review rather than committing
 * them silently: the roster is the operator's own working crosswalk, and
 * posting a year of revenue on an unconfirmed guess is exactly the silent
 * estimate this build refuses.
 */

/**
 * Why a resolution failed, so the review note can name the actual problem
 * instead of the generic "no entity".
 *
 * - `no_assignment`  — no truck by this unit number, or it has no carrier
 *                      period at all.
 * - `outside_period` — the unit is known, but no period covers this date: it
 *                      had left, or had not yet arrived. Attributing it to the
 *                      neighbouring period would be inventing a fact.
 * - `date_required`  — the unit transferred at least once, and this row has no
 *                      accrual date, so which side of the move it belongs to
 *                      is genuinely unknowable from the row itself.
 */
export type TruckResolutionFailure = 'no_assignment' | 'outside_period' | 'date_required';

export type TruckEntityResolution =
  | { entityId: string; resolvedFrom: 'truck_roster'; basis: string | null; confidence: string }
  | { entityId: null; resolvedFrom: 'unresolved'; reason: TruckResolutionFailure };

/**
 * `onDate` is the row's accrual date (ISO `YYYY-MM-DD`). When it is null the
 * lookup still succeeds for a unit that never moved — one period covering all
 * of time means the date cannot change the answer — and refuses for one that
 * did. That asymmetry is deliberate: most units never transfer, and refusing
 * those too would strand revenue for no gain.
 */
export async function resolveEntityFromTruck(
  q: QueryFn,
  unitNumber: string | null,
  onDate: string | null = null,
): Promise<TruckEntityResolution> {
  const unit = unitNumber?.trim();
  if (!unit) return { entityId: null, resolvedFrom: 'unresolved', reason: 'no_assignment' };

  const all = (await q(
    `SELECT h.entity_id, h.effective_from, h.effective_to, h.basis, h.confidence
       FROM accounting.truck_entity_history h
       JOIN accounting.truck t ON t.truck_id = h.truck_id
      WHERE t.unit_number = $1
      ORDER BY h.effective_from`,
    [unit],
  )) as Array<{
    entity_id: string;
    effective_from: Date | string;
    effective_to: Date | string | null;
    basis: string | null;
    confidence: string;
  }>;

  if (all.length === 0) {
    return { entityId: null, resolvedFrom: 'unresolved', reason: 'no_assignment' };
  }

  const hitOf = (r: (typeof all)[number]): TruckEntityResolution => ({
    entityId: r.entity_id,
    resolvedFrom: 'truck_roster',
    basis: r.basis,
    confidence: r.confidence,
  });

  if (onDate === null) {
    // Unambiguous only when the unit has a single period. Two rows means it
    // moved, and without a date there is no honest way to pick a side.
    const only = all.length === 1 ? all[0] : undefined;
    if (only) return hitOf(only);
    return { entityId: null, resolvedFrom: 'unresolved', reason: 'date_required' };
  }

  // Compared as ISO text, which sorts chronologically, so this needs no date
  // arithmetic and no timezone. `effective_to` null means still running.
  const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10));
  const hit = all.find(
    (r) => iso(r.effective_from) <= onDate && (r.effective_to === null || onDate <= iso(r.effective_to)),
  );

  if (!hit) return { entityId: null, resolvedFrom: 'unresolved', reason: 'outside_period' };
  return hitOf(hit);
}
