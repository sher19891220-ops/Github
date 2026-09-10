import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDriverEntityMap } from '@/ingest/fuel';

// Real, live-sheet export — never a synthetic fixture (CLAUDE.md §2).
const FIXTURE_PATH = '/home/user/opsdash-fixtures/fuelavg.txt';
const haveFixture = existsSync(FIXTURE_PATH);

describe.skipIf(!haveFixture)('buildDriverEntityMap — real fuelavg.txt', () => {
  const text = haveFixture ? readFileSync(FIXTURE_PATH, 'utf8') : '';

  it('parses end to end with no crash', () => {
    const result = buildDriverEntityMap(text);
    expect(result.taggedRowsUsed).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log('fuelavg driver->entity stats:', {
      taggedRowsUsed: result.taggedRowsUsed,
      uniqueDrivers: Object.keys(result.map).length,
      countsByEntity: result.countsByEntity,
      conflictCount: result.conflicts.length,
    });
  });

  it('normalizes the "xtuck" misspelling to "xtrack"', () => {
    const result = buildDriverEntityMap(text);
    expect(Object.values(result.map)).toContain('xtrack');
    expect(Object.values(result.map)).not.toContain('xtuck' as unknown as never);
  });

  it('maps drivers to all three entities with zero ambiguity, matching the measured baseline', () => {
    const result = buildDriverEntityMap(text);
    // SOURCE-DISCOVERY §8: xtrack 52, zone 40, afg 18, 110 drivers, 0 conflicts,
    // measured against this exact file. Real counts, not a rounded guess.
    expect(result.countsByEntity.xtrack).toBe(52);
    expect(result.countsByEntity.zone).toBe(40);
    expect(result.countsByEntity.afg).toBe(18);
    expect(Object.keys(result.map).length).toBe(110);
    expect(result.conflicts.length).toBe(0);
  });

  it('a driver seen under two entities is excluded from the map, not guessed', () => {
    const result = buildDriverEntityMap(text);
    for (const conflict of result.conflicts) {
      expect(result.map[conflict.driver]).toBeUndefined();
      expect(conflict.entities.length).toBeGreaterThan(1);
    }
  });
});
