/**
 * What "add a figure" means per source.
 *
 * `docs/INTAKE-MATRIX.md` lists nine sources, each needing the same four
 * intake paths. Nine bespoke forms would be nine places to get the sign
 * convention wrong. One form plus these presets is the same thing built
 * once: a preset chooses the category, the default sign, and which of the
 * optional fields are worth showing.
 *
 * Pure data and pure functions, so the whole thing is testable without a
 * DOM.
 */
import type { CategoryGroup } from '@/contract/types';

export interface EntryPreset {
  id: string;
  label: string;
  /** What a person is actually doing, in their words. */
  hint: string;
  /** Category groups whose categories this preset offers. Narrowing the
   *  picker is the point: a maintenance entry should not offer `revenue`. */
  categoryGroups: CategoryGroup[];
  /** Costs default to money out. Getting this wrong once flips a cost into
   *  revenue, and the total still looks plausible. */
  defaultSign: -1 | 1;
  /** Optional fields worth showing for this source. Everything else stays
   *  hidden rather than presented as an empty box to wonder about. */
  fields: {
    truck?: boolean;
    driver?: boolean;
    quantity?: { label: string };
    jurisdiction?: boolean;
    chargedTo?: boolean;
  };
  /** A real example of a basis, so the field reads as answerable rather
   *  than as a compliance box. */
  basisPlaceholder: string;
}

export const ENTRY_PRESETS: readonly EntryPreset[] = [
  {
    id: 'maintenance',
    label: 'Maintenance / repair',
    hint: 'A repair a shop has done or quoted, before the invoice arrives.',
    categoryGroups: ['maintenance'],
    defaultSign: -1,
    fields: { truck: true, driver: true, chargedTo: true },
    basisPlaceholder: 'Shop quoted $1,200 by phone; invoice to follow.',
  },
  {
    id: 'factoring',
    label: 'Factoring / collection',
    hint: 'What the factor actually did with an invoice — funded is not paid.',
    categoryGroups: ['revenue', 'other_cost'],
    defaultSign: 1,
    fields: { truck: true },
    basisPlaceholder: 'Read off the Triumph portal this morning.',
  },
  {
    id: 'ifta',
    label: 'IFTA miles by state',
    hint: 'Miles in one jurisdiction, from a Samsara or Motive screen.',
    categoryGroups: ['ifta'],
    defaultSign: -1,
    fields: { truck: true, quantity: { label: 'Miles' }, jurisdiction: true },
    basisPlaceholder: 'Samsara IFTA screen, Q3, export not available yet.',
  },
  {
    id: 'fuel',
    label: 'Fuel purchase',
    hint: 'A purchase not on a statement yet.',
    categoryGroups: ['fuel'],
    defaultSign: -1,
    fields: { truck: true, driver: true, quantity: { label: 'Gallons' }, jurisdiction: true, chargedTo: true },
    basisPlaceholder: 'Driver sent a photo of the receipt.',
  },
  {
    id: 'toll',
    label: 'Toll',
    hint: 'A crossing not on a transponder statement yet.',
    categoryGroups: ['toll'],
    defaultSign: -1,
    fields: { truck: true, chargedTo: true },
    basisPlaceholder: 'Driver reported the toll; statement is monthly.',
  },
  {
    id: 'registration',
    label: 'Registration / permit',
    hint: 'An IRP, HVUT or permit cost for one unit.',
    categoryGroups: ['permit'],
    defaultSign: -1,
    fields: { truck: true, chargedTo: true },
    basisPlaceholder: 'BMV counter gave this figure; receipt to follow.',
  },
  {
    id: 'intercompany',
    label: 'Intercompany',
    hint: 'A balance between two of the group companies.',
    categoryGroups: ['other_cost'],
    defaultSign: 1,
    fields: {},
    basisPlaceholder: 'Agreed on the recharge split; to be reconciled.',
  },
  {
    id: 'other',
    label: 'Something else',
    hint: 'Any category. Use this when none of the above fits.',
    categoryGroups: [
      'revenue', 'fuel', 'toll', 'maintenance', 'permit',
      'ifta', 'insurance', 'driver_pay', 'lease', 'other_cost',
    ],
    defaultSign: -1,
    fields: { truck: true, driver: true, quantity: { label: 'Quantity' }, jurisdiction: true, chargedTo: true },
    basisPlaceholder: 'Where this figure came from.',
  },
];

export function presetById(id: string): EntryPreset {
  return ENTRY_PRESETS.find((p) => p.id === id) ?? ENTRY_PRESETS[ENTRY_PRESETS.length - 1]!;
}

/**
 * Turns what a person typed into the signed decimal the ledger wants.
 *
 * People type `1200` for a $1,200 repair and mean money out. The form asks
 * for a magnitude and a direction separately rather than hoping somebody
 * remembers a minus sign, because a cost entered positive is revenue and
 * the P&L will look fine.
 *
 * Returns null for anything that is not a clean magnitude — the caller
 * shows an error rather than posting a number it had to guess at.
 */
export function toSignedAmount(magnitude: string, direction: 'in' | 'out'): string | null {
  const cleaned = magnitude.trim().replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^\d{1,12}(\.\d{1,2})?$/.test(cleaned)) return null;
  if (/^0+(\.0{1,2})?$/.test(cleaned)) return null; // a zero-value entry is not a figure
  return direction === 'out' ? `-${cleaned}` : cleaned;
}

/** What the form will actually post, for the "this is what gets saved"
 *  line. Showing it is cheap and it is the last chance to catch a sign. */
export function describeAmount(signed: string | null): string {
  if (signed === null) return '—';
  return signed.startsWith('-')
    ? `${signed} — money out of the company`
    : `${signed} — money into the company`;
}

export interface DraftValidity {
  ok: boolean;
  /** The first thing stopping this from being saved, in plain words. */
  reason: string | null;
}

/**
 * Everything the server will reject, checked here first so a person sees a
 * sentence instead of a constraint name. The server checks all of it again;
 * this is a courtesy, never the enforcement.
 */
export function validateDraft(draft: {
  entityId: string;
  categoryId: string;
  accrualDate: string;
  amount: string | null;
  assertedBy: string;
  basis: string;
}): DraftValidity {
  if (draft.entityId.trim() === '') return { ok: false, reason: 'Choose which company this belongs to.' };
  if (draft.categoryId.trim() === '') return { ok: false, reason: 'Choose a category.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.accrualDate)) {
    return { ok: false, reason: 'Pick the date the money belongs to.' };
  }
  if (draft.amount === null) {
    return { ok: false, reason: 'Enter an amount — digits and at most two decimal places.' };
  }
  if (draft.assertedBy.trim() === '') {
    return { ok: false, reason: 'Put your name on this. A figure nobody stands behind cannot be saved.' };
  }
  if (draft.basis.trim() === '') {
    return {
      ok: false,
      reason: 'Say what this is based on. A figure with no stated basis is a guess with a name attached.',
    };
  }
  return { ok: true, reason: null };
}
