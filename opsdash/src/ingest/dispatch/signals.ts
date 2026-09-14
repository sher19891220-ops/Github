/**
 * Driver-class and entity signal extraction.
 *
 * Both are read straight off the sheet, not resolved to canonical IDs —
 * that resolution belongs to `source_key_map` (DATA-CONTRACT.md §3),
 * which this parser has no access to. What is emitted here is the raw
 * signal the operator wrote, normalized only in spelling/case.
 */

/** `Payment` column -> driver class, per DATA-CONTRACT.md §5. */
export type DispatchDriverClass = 'company' | 'lease_to_own' | 'owner_operator' | 'unassigned';

const PAYMENT_MAP: Record<string, DispatchDriverClass> = {
  cpm: 'company',
  lo: 'lease_to_own',
  oo: 'owner_operator',
};

/**
 * Maps the `Payment` cell to a driver class. Case and trailing-space
 * variants (`cpm`, `CPM `, `CPM  `) all resolve. Anything else — the real
 * sheet also carries a literal `"30%"` in two rows, apparently a
 * commission note left in the wrong column — maps to `unassigned` rather
 * than being guessed at, so it surfaces for review instead of silently
 * becoming a class it was never marked as.
 */
export function mapDriverClass(paymentRaw: string): DispatchDriverClass {
  const key = paymentRaw.trim().toLowerCase();
  return PAYMENT_MAP[key] ?? 'unassigned';
}

const ENTITY_MARKER_RE = /\b(xtrack|xtuck|afg|zone)\b/i;

const ENTITY_CODE: Record<string, string> = {
  xtrack: 'XTRACK',
  xtuck: 'XTRACK', // spelling variant confirmed in the fuel summary sheet
  afg: 'AFG',
  zone: 'ZONE',
};

/**
 * Extracts an entity marker from the free-text driver-names cell —
 * `"<name> XTRACK"`, `"<name> / AFG"`, `"<name> (Xtrack)"`. Only 4.5% of
 * rows carry one (SOURCE-DISCOVERY.md §8); everything else must come back
 * null. **Never default to Zone here** — 7 trucks are marked inconsistently
 * week to week, so an absent marker means "unknown", not "this is Zone",
 * and guessing would misattribute the ~95% of revenue that carries no marker.
 */
export function extractEntityMarker(driverNamesRaw: string): string | null {
  const m = ENTITY_MARKER_RE.exec(driverNamesRaw);
  if (!m || !m[1]) return null;
  return ENTITY_CODE[m[1].toLowerCase()] ?? null;
}
