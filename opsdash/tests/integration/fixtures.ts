/**
 * Small, hand-built dispatch-sheet fragments for the integration suite.
 * Real fixture files (/home/user/opsdash-fixtures/dispatch2026.txt) already
 * exercise the parser thoroughly in tests/unit/dispatch.test.ts; these exist
 * only to give the *persistence* layer a document small enough to reason
 * about row-by-row (one truck-week, one revenue day), built to the exact
 * column layout tests/unit/dispatch.test.ts and src/ingest/dispatch/parse.ts
 * document.
 */

const HEADER_ROW = [
  '', 'Dispatcher', 'Truck #', 'Payment', 'Driver Names',
  'Mon, Jan 5, 2026', '', '',
  'Tue, Jan 6, 2026', '', '',
  'Wed, Jan 7, 2026', '', '',
  'Thu, Jan 8, 2026', '', '',
  'Fri, Jan 9, 2026', '', '',
  'Sat, Jan 10, 2026', '', '',
  'Sun, Jan 11, 2026', '', '',
  'Gross', 'Miles', 'RPM',
].join('|');

/** One truck-week, one revenue day (Monday, $500.00), entity marker XTRACK
 *  in the driver name so the persistence layer's entity resolution
 *  (through source_key_map) has something real to resolve. */
function dataRow(truckNumber: string, amount: string): string {
  return [
    '', 'D1', truckNumber, 'CPM', 'Jane Doe XTRACK',
    'CHI-NYC', `$${amount}`, '',
    '', '', '',
    '', '', '',
    '', '', '',
    '', '', '',
    '', '', '',
    '', '', '',
    `$${amount}`, '', '',
  ].join('|');
}

/** A single-truck-week dispatch fixture. `salt` keeps repeated calls
 *  content-distinct (different sha256) when the test wants two different
 *  documents; pass the same salt twice to test upload dedup. */
export function dispatchFixture(truckNumber: string, amount = '500.00'): string {
  return `${HEADER_ROW}\n${dataRow(truckNumber, amount)}\n`;
}

/**
 * A single-row "Truck and trailer expenses" fixture (variant A header —
 * SOURCE-DISCOVERY.md §5/"Corrected header" — no `Transfer code` column),
 * built to the exact column layout `src/ingest/expenses/parseExpenses.ts`'s
 * `detectExpenseHeader` requires. `chargedTo` is written straight into the
 * real "Expense side" column so the real parser (not a test shortcut)
 * produces `parsedPayload.chargedTo`, exactly as `charged_to` gets set in
 * production — that field has no slot in `StagingRowEdit` (DATA-CONTRACT.md
 * §6 contract gap noted in insertStagingRows.ts), so it can only ever come
 * from the parser reading it off a real-shaped row.
 */
const EXPENSE_HEADER_ROW = '| Unit | Issued To | Unit Type | Cost type | Date | $ used | Expense side | Details |';

/** Upload is content-addressed (documents.ts): a fixed literal body would
 *  make every call across every test run resolve to the same, eventually
 *  already-committed document. A random salt in the `Details` cell — a
 *  free-text column no parsing logic reads — keeps every call distinct. */
export function expensesFixture(
  unitNumber: string,
  amount: string,
  chargedTo: 'company' | 'driver',
  dateMmDdYy: string,
): string {
  const salt = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataRowLine = `| ${unitNumber} | Some Driver | truck | Repair | ${dateMmDdYy} | $${amount} | ${chargedTo} | test fixture ${salt} |`;
  return `${EXPENSE_HEADER_ROW}\n${dataRowLine}\n`;
}
