/**
 * The entry form's pure logic.
 *
 * Two of these functions are the difference between a usable form and a
 * quietly dangerous one. `toSignedAmount` exists because a cost typed
 * positive is revenue and the P&L still looks plausible; `validateDraft`
 * exists so a person sees a sentence instead of a Postgres constraint name.
 */
import { describe, expect, it } from 'vitest';
import {
  ENTRY_PRESETS,
  describeAmount,
  presetById,
  toSignedAmount,
  validateDraft,
} from '@/components/manual/presets';

describe('toSignedAmount', () => {
  it('signs a cost negative and a receipt positive', () => {
    expect(toSignedAmount('1200.00', 'out')).toBe('-1200.00');
    expect(toSignedAmount('1200.00', 'in')).toBe('1200.00');
  });

  it('accepts what a person actually types', () => {
    expect(toSignedAmount(' 1,200.50 ', 'out')).toBe('-1200.50');
    expect(toSignedAmount('$450', 'out')).toBe('-450');
    expect(toSignedAmount('7.5', 'in')).toBe('7.5');
  });

  it('refuses anything it would have to guess at', () => {
    // Never silently reinterpret: the caller shows an error instead.
    expect(toSignedAmount('', 'out')).toBeNull();
    expect(toSignedAmount('abc', 'out')).toBeNull();
    expect(toSignedAmount('12.345', 'out')).toBeNull();
    expect(toSignedAmount('-500', 'out')).toBeNull();
    expect(toSignedAmount('1e3', 'out')).toBeNull();
  });

  it('refuses a zero — that is not a figure', () => {
    expect(toSignedAmount('0', 'out')).toBeNull();
    expect(toSignedAmount('0.00', 'in')).toBeNull();
  });

  it('never produces negative zero', () => {
    // '-0.00' would post as zero with a sign, which reads as a real cost
    // of nothing at all.
    expect(toSignedAmount('0.00', 'out')).toBeNull();
  });
});

describe('describeAmount', () => {
  it('says which way the money goes, in words', () => {
    expect(describeAmount('-1200.00')).toMatch(/out of the company/);
    expect(describeAmount('1200.00')).toMatch(/into the company/);
    expect(describeAmount(null)).toBe('—');
  });
});

describe('presets', () => {
  it('defaults each source the way money actually moves for it', () => {
    expect(presetById('maintenance').defaultSign).toBe(-1);
    expect(presetById('fuel').defaultSign).toBe(-1);
    expect(presetById('factoring').defaultSign).toBe(1);
  });

  it('narrows the category picker to what the source can be', () => {
    // A maintenance entry must not offer 'revenue' — the picker is the
    // cheapest place to make a whole class of mistake impossible.
    expect(presetById('maintenance').categoryGroups).toEqual(['maintenance']);
    expect(presetById('maintenance').categoryGroups).not.toContain('revenue');
    expect(presetById('ifta').categoryGroups).toEqual(['ifta']);
  });

  it('shows the fields that source needs and no others', () => {
    expect(presetById('ifta').fields.jurisdiction).toBe(true);
    expect(presetById('ifta').fields.quantity?.label).toBe('Miles');
    expect(presetById('fuel').fields.quantity?.label).toBe('Gallons');
    // An intercompany balance is not truck-specific.
    expect(presetById('intercompany').fields.truck).toBeUndefined();
  });

  it('falls back to the catch-all rather than throwing on an unknown id', () => {
    expect(presetById('no-such-preset').id).toBe('other');
  });

  it('covers every source the intake matrix names', () => {
    const ids = ENTRY_PRESETS.map((p) => p.id);
    for (const needed of ['maintenance', 'factoring', 'ifta', 'intercompany']) {
      expect(ids).toContain(needed);
    }
  });

  it('gives every preset a real example of a basis', () => {
    // A placeholder like "reason" makes the field read as a compliance box;
    // a real sentence makes it read as answerable.
    for (const p of ENTRY_PRESETS) {
      expect(p.basisPlaceholder.length).toBeGreaterThan(15);
    }
  });
});

describe('validateDraft', () => {
  const valid = {
    entityId: 'e1',
    categoryId: 'maintenance.repair',
    accrualDate: '2026-04-10',
    amount: '-1200.00',
    assertedBy: 'controller@fleet',
    basis: 'Shop quoted by phone.',
  };

  it('accepts a complete draft', () => {
    expect(validateDraft(valid)).toEqual({ ok: true, reason: null });
  });

  it('names the first thing stopping the save, in plain words', () => {
    expect(validateDraft({ ...valid, entityId: '' }).reason).toMatch(/which company/i);
    expect(validateDraft({ ...valid, categoryId: '' }).reason).toMatch(/category/i);
    expect(validateDraft({ ...valid, accrualDate: 'soon' }).reason).toMatch(/date/i);
    expect(validateDraft({ ...valid, amount: null }).reason).toMatch(/amount/i);
  });

  it('will not let a figure be saved that nobody stands behind', () => {
    const noName = validateDraft({ ...valid, assertedBy: '   ' });
    expect(noName.ok).toBe(false);
    expect(noName.reason).toMatch(/stands behind/i);

    const noBasis = validateDraft({ ...valid, basis: '' });
    expect(noBasis.ok).toBe(false);
    expect(noBasis.reason).toMatch(/guess with a name attached/i);
  });
});
