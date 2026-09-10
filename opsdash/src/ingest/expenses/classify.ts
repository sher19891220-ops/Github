export type ChargedTo = 'company' | 'driver' | 'unknown';
export type UnitType = 'truck' | 'trailer' | 'unknown';
export type CategoryGroupHint = 'toll' | 'maintenance';

/**
 * `Expense side` drives lease-to-own margin, which is the reason this
 * dashboard exists. The real sheet is not limited to `company`/`driver`:
 * blanks, `Iron Lease exp`, `STL exp` and `?` all appear. Anything other
 * than an exact, recognized value comes back `unknown` so the reviewer sees
 * it, rather than silently defaulting to `company`.
 */
export function normalizeChargedTo(raw: string): { value: ChargedTo; raw: string } {
  const norm = raw.trim().toLowerCase();
  if (norm === 'company') return { value: 'company', raw };
  if (norm === 'driver') return { value: 'driver', raw };
  return { value: 'unknown', raw };
}

/**
 * `Unit Type` drives per-truck vs per-trailer cost attribution. Never
 * default to `truck` — an empty or unrecognized value (blank, `STL`) comes
 * back `unknown`.
 */
export function normalizeUnitType(raw: string): { value: UnitType; raw: string } {
  const norm = raw.trim().toLowerCase();
  if (norm === 'truck' || norm === 'tractor') return { value: 'truck', raw };
  if (norm === 'trailer' || norm === 'trl') return { value: 'trailer', raw };
  return { value: 'unknown', raw };
}

/**
 * Toll shows up in this sheet as rows whose vendor column reads exactly
 * "Toll violations", but also as a plain word in `Cost type`/`Details` for
 * other vendors (Ryder, Bowman, Milestone tollway/E-ZPass-style charges).
 * A case-insensitive "toll" match across vendor/cost-type/details is a
 * defensible superset of the documented rule and is recorded as a hint, not
 * a committed category — the review step still assigns the real
 * `category_id` from the maintained taxonomy.
 */
export function classifyCategoryGroup(fields: Array<string | null>): CategoryGroupHint {
  const hay = fields
    .filter((f): f is string => !!f)
    .join(' ')
    .toLowerCase();
  return hay.includes('toll') ? 'toll' : 'maintenance';
}

/**
 * A late section of the real sheet recycles the `Details` column to hold a
 * literal entity code (`Xtrack`, `AFG`, `Zone `) instead of free text. It is
 * a genuine, if undocumented, entity signal — but it is still just a raw
 * hint for the review step, never a resolved `entity_id`: CLAUDE.md forbids
 * resolving identity by string match, and one column recycled once is not
 * evidence the pattern holds everywhere.
 */
export function extractEntityHint(raw: string | null): 'zone' | 'xtrack' | 'afg' | null {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase();
  if (norm === 'zone') return 'zone';
  if (norm === 'xtrack' || norm === 'xtuck') return 'xtrack';
  if (norm === 'afg') return 'afg';
  return null;
}
