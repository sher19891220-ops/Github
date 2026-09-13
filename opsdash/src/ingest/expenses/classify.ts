export type ChargedTo = 'company' | 'driver' | 'unknown';
export type UnitType = 'truck' | 'trailer' | 'unknown';
export type CategoryGroupHint = 'toll' | 'maintenance';

/**
 * `Expense side` drives lease-to-own margin, which is the reason this
 * dashboard exists. The real sheet is not limited to `company`/`driver`:
 * blanks, `Iron Lease exp`, `STL exp` and `?` all appear. Anything other
 * than an exact, recognized value comes back `unknown` so the reviewer sees
 * it, rather than silently defaulting to `company`.
 *
 * **The `<name> exp` values carry a second fact.** `Xtrack exp` says both
 * that a company bears this cost AND which company — 170 rows and $67k of
 * 2026 spend say `Xtrack exp`, 92 say `AFG exp`, 98 say `Iron Lease exp` in
 * three spellings. Reading only the first fact threw the second away and
 * left that money unattributable. `bearerRaw` carries it out; it stays a raw
 * string, because resolving it to an `entity_id` is `source_key_map`'s job
 * and CLAUDE.md forbids matching identity by string anywhere else.
 *
 * `STL exp` is deliberately NOT treated as a carrier: STL is a terminal, and
 * the same sheet writes "from STL" in the details of rows belonging to all
 * three carriers. It comes back as a bearer string for the review step to
 * resolve or reject, never silently as a company.
 */
export function normalizeChargedTo(raw: string): {
  value: ChargedTo;
  raw: string;
  /** The name in a `<name> exp` value, lower-cased and trimmed; null
   *  otherwise. Never resolved to an entity here. */
  bearerRaw: string | null;
} {
  const norm = raw.trim().toLowerCase();
  if (norm === 'company') return { value: 'company', raw, bearerRaw: null };
  if (norm === 'driver') return { value: 'driver', raw, bearerRaw: null };

  // "Xtrack exp", "Iron lease exp", "STL exp\t" — one or more words then the
  // literal suffix "exp". Trailing markdown-escaped tabs (&#9;) are stripped
  // by the caller's cell unescaping, but guard the plain case too.
  const m = /^([a-z][a-z .&'-]*?)\s+exp\.?$/.exec(norm.replace(/\s+/g, ' ').trim());
  if (m && m[1]) {
    const bearer = m[1].trim();
    // "driver exp" is the driver side said the long way, not a company.
    if (bearer === 'driver') return { value: 'driver', raw, bearerRaw: null };
    return { value: 'company', raw, bearerRaw: bearer };
  }

  return { value: 'unknown', raw, bearerRaw: null };
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

/**
 * The carriers, as the `Expense side` column spells them. Only these three
 * are carriers: `iron lease` is the asset-holding company and `stl` is a
 * terminal, so both come back null and their rows wait for a person rather
 * than being booked to a carrier that did not bear them.
 */
export function carrierFromBearer(bearerRaw: string | null): 'zone' | 'xtrack' | 'afg' | null {
  if (!bearerRaw) return null;
  const norm = bearerRaw.trim().toLowerCase();
  if (norm === 'zone' || norm === 'zone oh') return 'zone';
  if (norm === 'xtrack' || norm === 'xtuck' || norm === 'xrack') return 'xtrack';
  if (norm === 'afg') return 'afg';
  return null;
}
