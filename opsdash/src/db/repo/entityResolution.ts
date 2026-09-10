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
  | { entityId: string; resolvedFrom: 'direct' | 'source_key_map' }
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
