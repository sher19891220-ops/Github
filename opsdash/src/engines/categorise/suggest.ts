/**
 * Suggesting a category for a free-text expense line.
 *
 * **A suggestion is not an assignment**, and every part of this module's
 * shape exists to keep those apart. `suggestCategory` returns the rule
 * that fired alongside the category, so a screen can show *why* rather
 * than just *what*; a description no rule recognises returns null rather
 * than a best guess; and nothing here writes anything.
 *
 * The rules are keyword rules, in order, specific before general. That is
 * not a limitation to apologise for — a classifier that cannot explain
 * itself is one nobody can check, and the operator has to be able to look
 * at "these 56 rows became maintenance.repair because they say 'repair'"
 * and agree or disagree in a second.
 *
 * The rule set was written from the real distribution rather than from
 * imagination: every pattern below matches something that actually
 * appears in the operator's expenses export.
 */
import { tokens, normalizeDescription } from './normalize';

export interface CategorySuggestion {
  categoryId: string;
  /** Why, in words, for the operator. */
  rule: string;
}

interface Rule {
  categoryId: string;
  rule: string;
  /** Matched against the token list, so word order and punctuation do not
   *  matter. A rule fires when ANY of its words is present. */
  any: readonly string[];
  /** ...unless one of these is also present. Lets a specific rule veto a
   *  general one without depending on ordering alone. */
  unless?: readonly string[];
}

/**
 * Order matters: the first match wins. So `toll violation` must be tested
 * before plain `toll`, and roadside work before generic repair — a tow
 * that says "towing for repair" is a roadside call, not a shop visit.
 */
const RULES: readonly Rule[] = [
  {
    categoryId: 'toll.violation',
    rule: 'mentions a violation, fine, citation or ticket',
    any: ['violation', 'violations', 'fine', 'fines', 'citation', 'ticket', 'penalty'],
  },
  {
    categoryId: 'toll.ezpass',
    rule: 'mentions a toll',
    any: ['toll', 'tolls', 'ezpass', 'ipass', 'sunpass', 'prepass'],
  },
  {
    categoryId: 'maintenance.roadside',
    rule: 'a roadside call rather than shop work',
    any: ['towing', 'tow', 'towed', 'jumpstart', 'jump', 'roadside', 'winch', 'winched', 'lockout', 'unlock'],
  },
  {
    categoryId: 'maintenance.tires',
    rule: 'about tires',
    any: ['tire', 'tires', 'tyre', 'tyres', 'retread', 'recap'],
  },
  {
    categoryId: 'maintenance.wash',
    rule: 'washing or detailing',
    any: ['wash', 'washed', 'washing', 'detailing', 'detail', 'detailed', 'cleaning', 'clean'],
    // "washer fluid" is a fluid, not a wash.
    unless: ['fluid'],
  },
  {
    categoryId: 'maintenance.pm',
    rule: 'scheduled service, an inspection, or a fluid',
    any: [
      'pm', 'inspection', 'dot', 'oil', 'lube', 'grease', 'filter', 'filters',
      'coolant', 'antifreeze', 'fluid', 'service', 'greasing', 'annual',
    ],
  },
  {
    categoryId: 'maintenance.supplies',
    rule: 'a consumable or fitting rather than a repair',
    any: [
      'strap', 'straps', 'chain', 'chains', 'mudflap', 'mudflaps', 'flap', 'flaps',
      'bungee', 'tarp', 'tarps', 'binder', 'binders', 'glove', 'gloves', 'light', 'lights',
      'bulb', 'bulbs', 'marker', 'reflector',
    ],
  },
  {
    categoryId: 'other_cost.parking',
    rule: 'parking or a yard fee',
    any: ['parking', 'park', 'yard', 'storage'],
  },
  {
    categoryId: 'maintenance.repair',
    rule: 'shop repair work',
    any: [
      'repair', 'repairs', 'repaired', 'replace', 'replacement', 'replaced', 'rebuild',
      'fix', 'fixed', 'weld', 'welding', 'body', 'brake', 'brakes', 'clutch', 'alternator',
      'starter', 'battery', 'batteries', 'apu', 'webasto', 'dryer', 'compressor', 'radiator',
      'transmission', 'engine', 'diagnostic', 'diagnostics', 'sensor', 'leak', 'hose', 'belt',
      'shop', 'labor', 'labour', 'part', 'parts',
    ],
  },
];

export function suggestCategory(description: string): CategorySuggestion | null {
  const words = new Set(tokens(description));
  if (words.size === 0) return null;

  for (const rule of RULES) {
    if (rule.unless?.some((w) => words.has(w))) continue;
    if (rule.any.some((w) => words.has(w))) {
      return { categoryId: rule.categoryId, rule: rule.rule };
    }
  }
  // No rule recognised it. Null, never a fallback: `maintenance.repair` is
  // a tempting default and would quietly absorb every description nobody
  // thought about, which is how a chart of accounts stops meaning
  // anything.
  return null;
}

/** Every category this rule set can propose, so a screen can offer them
 *  and a seed script can guarantee they exist. */
export function suggestableCategories(): string[] {
  return [...new Set(RULES.map((r) => r.categoryId))].sort();
}

export { normalizeDescription };
