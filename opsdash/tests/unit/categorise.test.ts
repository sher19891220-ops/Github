/**
 * Suggesting a category from a free-text expense description.
 *
 * Every description quoted below appears verbatim in the operator's real
 * expenses export — this rule set was written from the actual
 * distribution, not from imagination, and measured against it: 76% of
 * 1,342 rows and 80% of $719,411 get a suggestion. The remaining 247
 * distinct descriptions are genuine one-offs ("restack", "claim",
 * "bumper cover, add to aim fog lamps") that need a person.
 *
 * The tests that matter most are the ones about NOT suggesting.
 */
import { describe, expect, it } from 'vitest';
import { decodeEntities, normalizeDescription, tokens } from '@/engines/categorise/normalize';
import { suggestCategory, suggestableCategories } from '@/engines/categorise/suggest';

describe('normalizeDescription', () => {
  it('decodes the HTML entities the export leaves in cells', () => {
    // "truck wash" appears 23 times and "truck wash&#9;" 14 more — the
    // same expense, split by a numeric entity for a tab. 372 of them
    // across the real file.
    expect(normalizeDescription('truck wash&#9;')).toBe('truck wash');
    expect(normalizeDescription('truck wash')).toBe('truck wash');
    expect(normalizeDescription('truck wash&#9;')).toBe(normalizeDescription('truck wash'));
  });

  it('keeps a real ampersand, which is not noise', () => {
    // "M&Y Truck Repair" is a vendor name.
    expect(decodeEntities('M&amp;Y Truck Repair')).toBe('M&Y Truck Repair');
  });

  it('does not merge a detailed description into its general one', () => {
    // Same category, different rows. Collapsing them would hide how many
    // of each there are.
    expect(normalizeDescription('tire replacement')).not.toBe(
      normalizeDescription('tire replacement- right rear outside tire'),
    );
  });

  it('trims trailing punctuation and collapses whitespace', () => {
    expect(normalizeDescription('  Truck   Repair -  ')).toBe('truck   repair'.replace(/\s+/g, ' '));
    expect(normalizeDescription('towing.')).toBe('towing');
  });

  it('tokenises past punctuation so a rule matches either spelling', () => {
    expect(tokens('tire-replacement')).toEqual(['tire', 'replacement']);
  });
});

describe('suggestCategory — on real descriptions', () => {
  const cases: Array<[description: string, categoryId: string]> = [
    ['truck repair', 'maintenance.repair'],
    ['trailer repair', 'maintenance.repair'],
    ['tire', 'maintenance.tires'],
    ['tire replacement', 'maintenance.tires'],
    ['tire replacement- right rear outside tire', 'maintenance.tires'],
    ['towing', 'maintenance.roadside'],
    ['jumpstart', 'maintenance.roadside'],
    ['toll', 'toll.ezpass'],
    ['dot inspection', 'maintenance.pm'],
    ['coolant', 'maintenance.pm'],
    ['antifreeze', 'maintenance.pm'],
    ['truck wash', 'maintenance.wash'],
    ['truck wash&#9;', 'maintenance.wash'],
    ['interior detailing', 'maintenance.wash'],
    ['truck and trailer wash', 'maintenance.wash'],
    ['straps', 'maintenance.supplies'],
    ['chain', 'maintenance.supplies'],
    ['mudflap', 'maintenance.supplies'],
    ['parking', 'other_cost.parking'],
  ];

  for (const [description, categoryId] of cases) {
    it(`"${description}" -> ${categoryId}`, () => {
      expect(suggestCategory(description)?.categoryId).toBe(categoryId);
    });
  }

  it('always explains itself', () => {
    const s = suggestCategory('truck repair')!;
    expect(s.rule.length).toBeGreaterThan(0);
    // A classifier nobody can check is one nobody should trust with 235
    // rows at once.
    expect(s.rule).toMatch(/repair/i);
  });
});

describe('what it refuses to suggest', () => {
  it('returns null rather than a best guess', () => {
    // These are real unmatched descriptions. `maintenance.repair` is the
    // tempting default and would quietly absorb every description nobody
    // thought about — which is how a chart of accounts stops meaning
    // anything.
    for (const d of ['restack', 'claim', 'stl exp', 'truck issue', 'unit turn it with damage']) {
      expect(suggestCategory(d), d).toBeNull();
    }
  });

  it('returns null for an empty or punctuation-only description', () => {
    expect(suggestCategory('')).toBeNull();
    expect(suggestCategory('   ')).toBeNull();
    expect(suggestCategory('---')).toBeNull();
  });

  it('does not read "washer fluid" as a wash', () => {
    // A fluid, not a wash. The `unless` clause is what makes a specific
    // rule able to veto a general one without depending on order alone.
    expect(suggestCategory('washer fluid')?.categoryId).toBe('maintenance.pm');
    expect(suggestCategory('washer fluid&#9;')?.categoryId).toBe('maintenance.pm');
  });

  it('reads a violation as a violation, not a plain toll', () => {
    // Both contain "toll". The fine is not the toll, and netting them
    // together would hide how much is being paid in penalties.
    expect(suggestCategory('toll violation')?.categoryId).toBe('toll.violation');
    expect(suggestCategory('toll')?.categoryId).toBe('toll.ezpass');
  });

  it('reads a tow as roadside even when it mentions repair', () => {
    // Ordering: a roadside call that ends in shop work is still a
    // roadside call, and the general repair rule must not claim it.
    expect(suggestCategory('towing for repair')?.categoryId).toBe('maintenance.roadside');
  });

  it('reads a tire replacement as tires, not as a generic replacement', () => {
    expect(suggestCategory('tire replacement')?.categoryId).toBe('maintenance.tires');
  });
});

describe('suggestableCategories', () => {
  it('lists every category the rules can propose', () => {
    const all = suggestableCategories();
    expect(all).toContain('maintenance.repair');
    expect(all).toContain('maintenance.wash');
    expect(all).toContain('other_cost.parking');
    // Sorted and unique, so a seed script can compare against a chart of
    // accounts without sorting it first.
    expect(all).toEqual([...new Set(all)].sort());
  });
});
