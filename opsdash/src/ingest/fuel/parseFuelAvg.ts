import { tokenizeTable } from './table';

export type FuelAvgEntity = 'zone' | 'xtrack' | 'afg';

export interface DriverEntityConflict {
  driver: string;
  entities: FuelAvgEntity[];
}

export interface DriverEntityMapResult {
  /** Normalized driver name (trimmed, whitespace-collapsed, upper-cased) ->
   *  entity, for drivers seen under exactly one entity across the file. */
  map: Record<string, FuelAvgEntity>;
  countsByEntity: Record<FuelAvgEntity, number>;
  /** Drivers seen tagged with more than one entity — excluded from `map`
   *  rather than guessed at, per CLAUDE.md's "never resolve identity by
   *  string match" and the contract's "no silent estimates" rule. */
  conflicts: DriverEntityConflict[];
  taggedRowsUsed: number;
}

function normalizeEntity(token: string): FuelAvgEntity | null {
  const t = token.trim().toLowerCase();
  if (t === 'xtuck' || t === 'xtrack') return 'xtrack'; // "xtuck" is a misspelling of "xtrack"
  if (t === 'zone') return 'zone';
  if (t === 'afg') return 'afg';
  return null;
}

function normalizeDriverName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * `Fuel Avrg Company Report` lays out three entity blocks side by side
 * across the columns, not stacked in rows — and the exact column layout
 * changes repeatedly over the ~40 weekly snapshots this export contains
 * (some drop the entity label, some collapse to two unlabelled groups, some
 * are an entirely different report — MPG/idle-time, retail-vs-discount
 * price — with no entity information at all). Modelling every layout by
 * header would be fragile and would silently stop working the next time the
 * sheet's shape drifts.
 *
 * Instead: within every recognized fuel-avg table, wherever a cell is
 * *exactly* `xtuck`/`xtrack`/`zone`/`afg`, the next cell is that row's
 * driver name for that entity's block. This is position-independent (robust
 * to the column reordering elsewhere in this codebase's fuel parser) and
 * false-positive-proof (a whole-cell match, not a substring, so a note or
 * address cannot collide with it). Sections that don't carry the entity
 * label at all are correctly not represented in the output, rather than
 * guessed — SOURCE-DISCOVERY §8 explicitly measured this to be the only
 * technique that gets zero ambiguous drivers.
 */
export function buildDriverEntityMap(text: string): DriverEntityMapResult {
  const rows = tokenizeTable(text);
  const driverEntities = new Map<string, Set<FuelAvgEntity>>();
  const displayName = new Map<string, string>();
  let taggedRowsUsed = 0;

  for (const { cells, isAlignment } of rows) {
    if (isAlignment) continue;
    for (let i = 0; i < cells.length; i++) {
      const entity = normalizeEntity(cells[i] ?? '');
      if (!entity) continue;
      const driverRaw = cells[i + 1];
      if (!driverRaw) continue;
      const driverTrimmed = driverRaw.trim();
      if (!driverTrimmed) continue;
      const lower = driverTrimmed.toLowerCase();
      if (lower === 'driver name' || lower === 'driver') continue; // the header row itself

      const key = normalizeDriverName(driverTrimmed);
      if (!driverEntities.has(key)) driverEntities.set(key, new Set());
      driverEntities.get(key)?.add(entity);
      if (!displayName.has(key)) displayName.set(key, driverTrimmed);
      taggedRowsUsed += 1;
    }
  }

  const map: Record<string, FuelAvgEntity> = {};
  const countsByEntity: Record<FuelAvgEntity, number> = { zone: 0, xtrack: 0, afg: 0 };
  const conflicts: DriverEntityConflict[] = [];

  for (const [driver, entities] of driverEntities) {
    if (entities.size === 1) {
      const entity = [...entities][0] as FuelAvgEntity;
      map[driver] = entity;
      countsByEntity[entity] += 1;
    } else {
      conflicts.push({ driver, entities: [...entities] });
    }
  }

  return { map, countsByEntity, conflicts, taggedRowsUsed };
}
