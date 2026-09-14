/**
 * `GET /api/reference` — picker option lists for the review screen.
 *
 * Not in the original DATA-CONTRACT.md §6, added per the coordinator's
 * relay of the UI workstream's gap report. Inactive rows are returned, not
 * filtered out — `NamedOption.isActive` exists precisely so a historical
 * row naming a now-inactive entity/truck/driver stays explicable, and the
 * screen (not this endpoint) decides not to offer them for new selections.
 */
import type { CategoryOption, NamedOption, ReferenceData } from '@/contract/types';
import { query } from '@/db/pool';

export async function getReferenceData(): Promise<ReferenceData> {
  const [entities, trucks, drivers, categories] = await Promise.all([
    query<{ id: string; label: string; is_active: boolean }>(
      `SELECT entity_id AS id, legal_name AS label, is_active FROM accounting.entity ORDER BY legal_name`,
    ),
    query<{ id: string; label: string; is_active: boolean }>(
      `SELECT truck_id AS id, unit_number AS label, is_active FROM accounting.truck ORDER BY unit_number`,
    ),
    query<{ id: string; label: string; is_active: boolean }>(
      `SELECT driver_id AS id, full_name AS label, is_active FROM accounting.driver ORDER BY full_name`,
    ),
    query<{ id: string; label: string; category_group: string; sign: number; is_active: boolean }>(
      `SELECT category_id AS id, display_name AS label, category_group, sign, is_active
       FROM accounting.category ORDER BY category_group, display_name`,
    ),
  ]);

  return {
    entities: entities.map(toNamedOption),
    trucks: trucks.map(toNamedOption),
    drivers: drivers.map(toNamedOption),
    categories: categories.map(
      (c): CategoryOption => ({
        id: c.id,
        label: c.label,
        categoryGroup: c.category_group as CategoryOption['categoryGroup'],
        sign: c.sign as 1 | -1,
        isActive: c.is_active,
      }),
    ),
  };
}

function toNamedOption(r: { id: string; label: string; is_active: boolean }): NamedOption {
  return { id: r.id, label: r.label, isActive: r.is_active };
}
