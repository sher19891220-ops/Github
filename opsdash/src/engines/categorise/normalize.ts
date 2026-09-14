/**
 * Normalising a free-text expense description.
 *
 * Measured on the operator's real expenses export: 1,342 rows carry 807
 * distinct descriptions. Grouping on the raw text is therefore almost
 * useless — the top hundred descriptions cover 591 rows, under half the
 * file — and the reason is that the same thing is written many ways.
 *
 * Two kinds of variation, and they need different treatment:
 *
 *  - **Noise that means nothing.** `truck wash` appears 23 times and
 *    `truck wash&#9;` 14 more. That is the same expense twice, split by an
 *    HTML numeric entity for a tab that the export left in the cell and
 *    the parser never decoded — 372 of them across the file. Normalising
 *    it away is pure gain.
 *  - **Detail that means something.** `tire replacement` and `tire
 *    replacement- right rear outside tire` are the same category and not
 *    the same row. Normalisation must not merge them into one description,
 *    only recognise that both are about tires. That is what the rules in
 *    `suggest.ts` are for; this file stops short of it deliberately.
 */

/** The entities this export actually contains, plus the few that any
 *  HTML-ish export produces. Decoded rather than stripped: `&amp;` in
 *  "M&Y Truck Repair" is a real ampersand, not noise. */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d{1,5});/g, (_, code: string) => {
      const n = Number(code);
      // Control characters become a space — a tab inside a cell is
      // whitespace, not content.
      return n < 32 ? ' ' : String.fromCharCode(n);
    })
    .replace(/&#x([0-9a-fA-F]{1,4});/g, (_, hex: string) => {
      const n = parseInt(hex, 16);
      return n < 32 ? ' ' : String.fromCharCode(n);
    })
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED[name.toLowerCase()] ?? whole);
}

/**
 * The grouping key for a description.
 *
 * Lowercased, entities decoded, whitespace collapsed, and trailing
 * punctuation dropped. Internal punctuation is kept: `tire replacement-
 * right rear` stays distinguishable from `tire replacement`, because they
 * are different rows about the same category and collapsing them would
 * hide how many of each there are.
 */
export function normalizeDescription(text: string): string {
  return decodeEntities(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:.,;]+|[\s\-–—:.,;]+$/g, '')
    .trim();
}

/** Words a rule may match on: the normalised description reduced to
 *  alphabetic tokens, so `tire-replacement` and `tire replacement` match
 *  the same rules. */
export function tokens(text: string): string[] {
  return normalizeDescription(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t !== '');
}
