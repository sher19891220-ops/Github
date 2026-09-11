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
 * This goes through `source_key_map` like every other identity lookup —
 * never a string match against `entity.code` — under its own source
 * system, so a truck-derived attribution stays distinguishable from one
 * the sheet actually stated. The caller marks rows resolved this way for
 * review rather than committing them silently: the roster's own column is
 * named `entity_CONFIRM_THIS`, and posting a year of revenue on somebody
 * else's unconfirmed guess is exactly the silent estimate this build
 * refuses.
 */
export const TRUCK_ROSTER_SOURCE = 'truck_roster';

export async function resolveEntityFromTruck(
  q: QueryFn,
  unitNumber: string | null,
): Promise<EntityResolution> {
  const unit = unitNumber?.trim();
  if (!unit) return { entityId: null, resolvedFrom: 'unresolved' };

  const rows = await q(
    `SELECT canonical_id FROM accounting.source_key_map
      WHERE canonical_kind = 'entity' AND source_system = $1 AND source_key = $2`,
    [TRUCK_ROSTER_SOURCE, unit],
  );
  const row = rows[0] as { canonical_id: string } | undefined;
  if (row) return { entityId: row.canonical_id, resolvedFrom: 'truck_roster' };
  return { entityId: null, resolvedFrom: 'unresolved' };
}
