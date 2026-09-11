/**
 * What the IFTA engine actually runs on.
 *
 * The engine (src/engines/ifta) is pure: miles in, fuel in, rates in, a
 * return out. This module is the only place that decides where those three
 * come from, and each one comes from a different kind of place for a
 * reason worth stating:
 *
 *  - **Miles come from staging, not the ledger.** A mileage report records
 *    a measurement, not money. Its rows carry a jurisdiction and a
 *    quantity and no amount, so they never post — they stay attached to
 *    the `source_document` they were read from, which is the same standard
 *    of proof the ledger holds, at a different destination.
 *
 *  - **Fuel comes from the ledger.** A fuel purchase *is* money, it is
 *    already posted, and `ledger_entry` already carries `quantity`
 *    (gallons) and `jurisdiction` (purchase state) for exactly this
 *    purpose — 001 says so in a comment written before this engine existed.
 *
 *  - **Rates come from `ifta_rate`, and nowhere else.** They are not
 *    derivable, not scrapeable from anything this build ingests, and not
 *    defaultable. A jurisdiction with no rate on file has its line
 *    withheld by the engine and named in `problems`.
 *
 * Two refusals live here rather than in the engine, because they are about
 * the data's shape rather than the arithmetic:
 *
 *  - **A period may not span calendar quarters.** IFTA rates are set per
 *    quarter. A period crossing a boundary has no single rate, and picking
 *    either quarter's would produce a return that is wrong for half its
 *    days without saying so.
 *
 *  - **A mileage report is used whole or not at all.** The report states a
 *    period and a total; it does not state miles per day. Apportioning a
 *    quarter's miles across a requested week would be an invented number
 *    wearing a measured one's clothes. A report that only partially
 *    overlaps the requested period is excluded and named.
 *
 * That second one is the live limit on the operator's "daily and weekly"
 * ask: the engine computes any period, and the *mileage source* currently
 * available is quarterly. A weekly accrual needs daily mileage, which means
 * a Samsara/Motive pull or a daily export. Said on screen, not hidden.
 */
import { createHash, randomUUID } from 'node:crypto';
import { query, withTransaction } from '@/db/pool';
import { parseIftaRateMatrix, type RateMatrixParse } from '@/ingest/iftaRates/parseMatrix';
import {
  calculateIfta,
  classifyPeriod,
  IftaInputError,
  type IftaInput,
  type IftaRate,
  type IftaResult,
} from '@/engines/ifta';

export class IftaRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IftaRequestError';
  }
}

const ENGINE_VERSION = '1.0.0';

/* --------------------------------------------------------------------- */
/* Quarters                                                              */
/* --------------------------------------------------------------------- */

export interface Quarter {
  year: number;
  quarter: 1 | 2 | 3 | 4;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function quarterOf(isoDate: string): Quarter {
  if (!ISO_DATE.test(isoDate)) throw new IftaRequestError(`Not a date: ${JSON.stringify(isoDate)}`);
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  if (month < 1 || month > 12) throw new IftaRequestError(`Not a month: ${JSON.stringify(isoDate)}`);
  return { year, quarter: (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4 };
}

/** True when `inner` lies entirely within `outer`. ISO dates compare
 *  correctly as strings, which is why they are kept as strings. */
function contains(outerFrom: string, outerTo: string, innerFrom: string, innerTo: string): boolean {
  return innerFrom >= outerFrom && innerTo <= outerTo;
}

function overlaps(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

/* --------------------------------------------------------------------- */
/* Reading the inputs                                                    */
/* --------------------------------------------------------------------- */

export interface MileageDocumentSummary {
  documentId: string;
  fileName: string;
  carrier: string;
  periodStart: string;
  periodEnd: string;
  entityId: string | null;
  rowCount: number;
  /** Set when this report is NOT contributing miles, and why. */
  excludedReason: string | null;
}

export interface IftaSources {
  mileageDocuments: MileageDocumentSummary[];
  /** Ledger fuel rows that carry gallons and a purchase state. */
  fuelEntryCount: number;
  /** Fuel rows in the same window that cannot earn a credit because they
   *  are missing gallons or a purchase state. The single biggest silent
   *  under-credit in an IFTA return, so it is counted, never dropped. */
  fuelEntriesUnusable: number;
  unusableFuelAmount: string;
  rateCount: number;
  rateSourceNotes: string[];
}

export interface IftaReturnView {
  from: string;
  to: string;
  entityId: string | null;
  quarter: Quarter;
  periodKind: 'quarter' | 'accrual';
  /** Null when the engine refused — see `blocked` for the reason. */
  result: IftaResult | null;
  blocked: string | null;
  /** Problems about the *inputs*, distinct from the engine's problems
   *  about the *return*. Both are shown; conflating them would hide which
   *  ones a person can fix by uploading something. */
  sourceProblems: string[];
  sources: IftaSources;
}

export interface GetIftaOptions {
  from: string;
  to: string;
  entityId?: string | undefined;
  mpgDecimalPlaces?: number | undefined;
}

export async function getIftaReturn(options: GetIftaOptions): Promise<IftaReturnView> {
  const { from, to } = options;
  const entityId = options.entityId ?? null;

  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new IftaRequestError('from and to must both be YYYY-MM-DD dates.');
  }
  if (from > to) throw new IftaRequestError('from must not be after to.');

  const qStart = quarterOf(from);
  const qEnd = quarterOf(to);
  if (qStart.year !== qEnd.year || qStart.quarter !== qEnd.quarter) {
    throw new IftaRequestError(
      `This period runs from ${qStart.year} Q${qStart.quarter} into ${qEnd.year} Q${qEnd.quarter}. ` +
        'IFTA rates are set per quarter, so a period spanning two of them has no single rate — ' +
        'ask for each quarter separately rather than getting one figure that is wrong for half its days.',
    );
  }

  const sourceProblems: string[] = [];

  const mileageDocuments = await readMileageDocuments(from, to, entityId, sourceProblems);
  const includedDocIds = mileageDocuments.filter((d) => d.excludedReason === null).map((d) => d.documentId);
  const milesByJurisdiction = await readMiles(includedDocIds);

  const fuel = await readFuel(from, to, entityId);
  const rates = await readRates(qStart);

  const sources: IftaSources = {
    mileageDocuments,
    fuelEntryCount: fuel.usableCount,
    fuelEntriesUnusable: fuel.unusableCount,
    unusableFuelAmount: fuel.unusableAmount,
    rateCount: rates.length,
    rateSourceNotes: [...new Set(rates.map((r) => r.sourceNote))].sort(),
  };

  if (fuel.unusableCount > 0) {
    const one = fuel.unusableCount === 1;
    sourceProblems.push(
      `${fuel.unusableCount} fuel purchase${one ? '' : 's'} in this period ` +
        `(${fuel.unusableAmount} of spend) ${one ? 'carries' : 'carry'} no gallons or no purchase state, so ${one ? 'it earns' : 'they earn'} no tax-paid credit. ` +
        `${one ? 'It is' : 'They are'} missing from the return, which makes the amount owed too high, not too low.`,
    );
  }
  if (rates.length === 0) {
    sourceProblems.push(
      `No IFTA rates are on file for ${qStart.year} Q${qStart.quarter}. ` +
        'Every jurisdiction will be withheld until they are entered — rates are published quarterly and are not derivable from anything this system ingests.',
    );
  }

  const periodKind = classifyPeriod(from, to);

  const input: IftaInput = {
    periodStart: from,
    periodEnd: to,
    milesByJurisdiction,
    fuelByJurisdiction: fuel.byJurisdiction,
    rates: rates.map((r) => r.rate),
    ...(options.mpgDecimalPlaces !== undefined ? { mpgDecimalPlaces: options.mpgDecimalPlaces } : {}),
  };

  let result: IftaResult | null = null;
  let blocked: string | null = null;
  try {
    result = calculateIfta(input);
  } catch (err) {
    if (err instanceof IftaInputError) blocked = err.message;
    else throw err;
  }

  return {
    from,
    to,
    entityId,
    quarter: qStart,
    periodKind,
    result,
    blocked,
    sourceProblems,
    sources,
  };
}

/* --------------------------------------------------------------------- */

interface MileageDocRow {
  document_id: string;
  file_name: string;
  carrier: string | null;
  period_start: string | null;
  period_end: string | null;
  row_count: string;
}

async function readMileageDocuments(
  from: string,
  to: string,
  entityId: string | null,
  problems: string[],
): Promise<MileageDocumentSummary[]> {
  // A document's period is a property of the document, so it is read from
  // the rows' immutable `parsed_payload`, not from anything a reviewer can
  // edit. A reviewer corrects a state code or a mileage figure; they do
  // not move a report into a different quarter.
  const rows = await query<MileageDocRow>(
    `SELECT d.document_id,
            d.file_name,
            min(s.parsed_payload->>'carrier')     AS carrier,
            min(s.parsed_payload->>'periodStart') AS period_start,
            max(s.parsed_payload->>'periodEnd')   AS period_end,
            count(*)                              AS row_count
       FROM accounting.staging_row s
       JOIN accounting.source_document d ON d.document_id = s.document_id
      WHERE d.doc_type = 'ifta_mileage'
        AND s.status <> 'rejected'
        AND s.quantity IS NOT NULL
        AND s.jurisdiction IS NOT NULL
      GROUP BY d.document_id, d.file_name
      ORDER BY min(s.parsed_payload->>'periodStart'), d.file_name`,
  );

  const carriers = [...new Set(rows.map((r) => r.carrier).filter((c): c is string => !!c))];
  const entityByCarrier = await resolveCarriers(carriers);

  const out: MileageDocumentSummary[] = [];
  for (const r of rows) {
    const start = r.period_start ?? '';
    const end = r.period_end ?? '';
    const carrier = r.carrier ?? '';
    const docEntityId = entityByCarrier.get(carrier) ?? null;

    let excludedReason: string | null = null;
    if (start === '' || end === '') {
      excludedReason = 'This report states no period, so its miles belong to no quarter.';
    } else if (!overlaps(from, to, start, end)) {
      // Outside the window entirely — not a problem, just not this period.
      continue;
    } else if (!contains(from, to, start, end)) {
      excludedReason =
        `This report covers ${start} to ${end}, which is not entirely inside the requested period. ` +
        'It states a total for its own period and no miles per day, so splitting it would be an invented figure, not a measured one.';
    } else if (entityId !== null && docEntityId !== entityId) {
      excludedReason =
        docEntityId === null
          ? `Carrier "${carrier}" is not mapped to an entity, so this report cannot be attributed to the one requested.`
          : 'This report belongs to a different entity.';
    }

    if (excludedReason !== null) problems.push(`${r.file_name}: ${excludedReason}`);

    out.push({
      documentId: r.document_id,
      fileName: r.file_name,
      carrier,
      periodStart: start,
      periodEnd: end,
      entityId: docEntityId,
      rowCount: Number(r.row_count),
      excludedReason,
    });
  }

  if (out.length === 0) {
    problems.push(
      'No IFTA mileage report covers this period. Miles by state are the one input nothing else can supply — ' +
        'drop the telematics IFTA report on the Documents screen, or pull it from a connected sheet.',
    );
  }

  await flagOverlappingReports(out, problems);
  return out;
}

/**
 * Two reports covering the same period are summed, and usually that is
 * right: every real export seen so far carries a single jurisdiction, so a
 * quarter arrives as several files, one state each.
 *
 * It is wrong in exactly one case — when two of them report the SAME
 * jurisdiction. That is a re-export, not a second state, and summing it
 * doubles those miles, which doubles that state's taxable gallons and the
 * tax on them. Nothing downstream can detect it: the total is internally
 * consistent and simply too large.
 *
 * So it is named here and the reports stay included. Excluding one
 * automatically would mean guessing which of two documents a human
 * uploaded is the real one, and the wrong guess is a silently short return
 * rather than a visibly long one.
 */
async function flagOverlappingReports(
  docs: MileageDocumentSummary[],
  problems: string[],
): Promise<void> {
  const included = docs.filter((d) => d.excludedReason === null);
  if (included.length < 2) return;

  const rows = await query<{ document_id: string; jurisdiction: string }>(
    `SELECT DISTINCT document_id, jurisdiction
       FROM accounting.staging_row
      WHERE document_id = ANY($1::uuid[])
        AND status <> 'rejected'
        AND jurisdiction IS NOT NULL`,
    [included.map((d) => d.documentId)],
  );

  const nameById = new Map(included.map((d) => [d.documentId, d.fileName]));
  const filesByJurisdiction = new Map<string, string[]>();
  for (const r of rows) {
    const list = filesByJurisdiction.get(r.jurisdiction) ?? [];
    list.push(nameById.get(r.document_id) ?? r.document_id);
    filesByJurisdiction.set(r.jurisdiction, list);
  }

  for (const [jurisdiction, files] of [...filesByJurisdiction].sort()) {
    if (files.length < 2) continue;
    problems.push(
      `${jurisdiction} miles appear in ${files.length} reports for this period (${files.sort().join(', ')}), ` +
        'and all of them are being added together. If one is a re-export of another, this state\'s miles — ' +
        'and the tax on them — are doubled. Reject the duplicate on the review queue.',
    );
  }
}

async function resolveCarriers(carriers: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (carriers.length === 0) return map;

  // A carrier line is a printed letterhead, not a key — the legal name
  // followed by a street address, all on one line. Matched by the legal
  // name being a *prefix* of it rather than by equality, which is why this
  // is a lookup over entities rather than a join.
  const entities = await query<{ entity_id: string; legal_name: string; code: string }>(
    `SELECT entity_id, legal_name, code FROM accounting.entity`,
  );
  for (const carrier of carriers) {
    const upper = carrier.toUpperCase();
    const hit =
      entities.find((e) => upper.startsWith(e.legal_name.toUpperCase())) ??
      entities.find((e) => upper.startsWith(`${e.code.toUpperCase()} `));
    if (hit) map.set(carrier, hit.entity_id);
  }
  return map;
}

async function readMiles(documentIds: string[]): Promise<IftaInput['milesByJurisdiction']> {
  if (documentIds.length === 0) return [];
  const rows = await query<{ jurisdiction: string; miles: string }>(
    `SELECT jurisdiction, sum(quantity)::text AS miles
       FROM accounting.staging_row
      WHERE document_id = ANY($1::uuid[])
        AND status <> 'rejected'
        AND quantity IS NOT NULL
        AND jurisdiction IS NOT NULL
      GROUP BY jurisdiction
      ORDER BY jurisdiction`,
    [documentIds],
  );
  // `quantity` is numeric(14,4); miles are printed in hundredths. Trimming
  // the two trailing zeros keeps the engine's 2-decimal miles parser happy
  // without ever dropping a digit that was really there.
  return rows.map((r) => ({ jurisdiction: r.jurisdiction, miles: trimToPlaces(r.miles, 2) }));
}

/** Drops trailing zeros beyond `places`. Throws rather than round if a
 *  non-zero digit sits past them — that is real precision, and silently
 *  discarding it is how a mileage total drifts. */
export function trimToPlaces(value: string, places: number): string {
  const m = /^(-?\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!m) throw new IftaRequestError(`Not a decimal figure: ${JSON.stringify(value)}`);
  const frac = m[2] ?? '';
  if (frac.length <= places) return frac === '' ? m[1]! : `${m[1]}.${frac}`;
  const keep = frac.slice(0, places);
  const rest = frac.slice(places);
  if (/[1-9]/.test(rest)) {
    throw new IftaRequestError(
      `${JSON.stringify(value)} carries precision past ${places} decimal places; dropping it here would change the figure.`,
    );
  }
  return `${m[1]}.${keep}`;
}

interface FuelRead {
  byJurisdiction: IftaInput['fuelByJurisdiction'];
  usableCount: number;
  unusableCount: number;
  unusableAmount: string;
}

async function readFuel(from: string, to: string, entityId: string | null): Promise<FuelRead> {
  const params: unknown[] = [from, to];
  let entityClause = '';
  if (entityId !== null) {
    params.push(entityId);
    entityClause = ` AND l.entity_id = $${params.length}`;
  }

  const usable = await query<{ jurisdiction: string; gallons: string; n: string }>(
    `SELECT l.jurisdiction, sum(l.quantity)::text AS gallons, count(*) AS n
       FROM accounting.ledger_entry l
       JOIN accounting.category c ON c.category_id = l.category_id
      WHERE c.category_group = 'fuel'
        AND l.accrual_date BETWEEN $1::date AND $2::date
        AND l.quantity IS NOT NULL
        AND l.jurisdiction IS NOT NULL${entityClause}
      GROUP BY l.jurisdiction
      ORDER BY l.jurisdiction`,
    params,
  );

  const unusable = await query<{ n: string; amount: string }>(
    `SELECT count(*) AS n, COALESCE(sum(abs(l.amount)), 0)::text AS amount
       FROM accounting.ledger_entry l
       JOIN accounting.category c ON c.category_id = l.category_id
      WHERE c.category_group = 'fuel'
        AND l.accrual_date BETWEEN $1::date AND $2::date
        AND (l.quantity IS NULL OR l.jurisdiction IS NULL)${entityClause}`,
    params,
  );

  return {
    byJurisdiction: usable.map((r) => ({ jurisdiction: r.jurisdiction, gallons: trimToPlaces(r.gallons, 4) })),
    usableCount: usable.reduce((a, r) => a + Number(r.n), 0),
    unusableCount: Number(unusable[0]?.n ?? 0),
    unusableAmount: unusable[0]?.amount ?? '0.00',
  };
}

interface StoredRate {
  rate: IftaRate;
  sourceNote: string;
}

async function readRates(q: Quarter): Promise<StoredRate[]> {
  const rows = await query<{
    jurisdiction: string;
    rate_per_gallon: string;
    surcharge_per_gallon: string;
    source_note: string;
  }>(
    `SELECT jurisdiction, rate_per_gallon, surcharge_per_gallon, source_note
       FROM accounting.ifta_rate
      WHERE period_year = $1 AND period_quarter = $2 AND fuel_type = 'diesel'
      ORDER BY jurisdiction`,
    [q.year, q.quarter],
  );
  return rows.map((r) => ({
    sourceNote: r.source_note,
    rate: {
      jurisdiction: r.jurisdiction.trim(),
      ratePerGallon: r.rate_per_gallon,
      surchargePerGallon: r.surcharge_per_gallon,
    },
  }));
}

/* --------------------------------------------------------------------- */
/* Rates in                                                              */
/* --------------------------------------------------------------------- */

export interface RateEntry {
  jurisdiction: string;
  year: number;
  quarter: number;
  ratePerGallon: string;
  surchargePerGallon?: string | undefined;
  sourceNote: string;
  enteredBy: string;
}

export async function listRates(q: Quarter): Promise<
  Array<{
    jurisdiction: string;
    ratePerGallon: string;
    surchargePerGallon: string;
    sourceNote: string;
    enteredBy: string;
    enteredAt: string;
  }>
> {
  const rows = await query<{
    jurisdiction: string;
    rate_per_gallon: string;
    surcharge_per_gallon: string;
    source_note: string;
    entered_by: string;
    entered_at: Date;
  }>(
    `SELECT jurisdiction, rate_per_gallon, surcharge_per_gallon, source_note, entered_by, entered_at
       FROM accounting.ifta_rate
      WHERE period_year = $1 AND period_quarter = $2 AND fuel_type = 'diesel'
      ORDER BY jurisdiction`,
    [q.year, q.quarter],
  );
  return rows.map((r) => ({
    jurisdiction: r.jurisdiction.trim(),
    ratePerGallon: r.rate_per_gallon,
    surchargePerGallon: r.surcharge_per_gallon,
    sourceNote: r.source_note,
    enteredBy: r.entered_by,
    enteredAt: new Date(r.entered_at).toISOString(),
  }));
}

/**
 * Records one jurisdiction's rate for one quarter.
 *
 * `sourceNote` and `enteredBy` are required by the table and required here
 * for the same reason the manual-entry path requires an attestation: a rate
 * is the one input to this engine that no document supplies, so the only
 * provenance it can have is a named person naming where they read it.
 */
export async function upsertRate(entry: RateEntry): Promise<void> {
  const jurisdiction = entry.jurisdiction.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(jurisdiction)) {
    throw new IftaRequestError(`Jurisdiction must be two letters, got ${JSON.stringify(entry.jurisdiction)}.`);
  }
  if (entry.quarter < 1 || entry.quarter > 4 || !Number.isInteger(entry.quarter)) {
    throw new IftaRequestError('Quarter must be 1, 2, 3 or 4.');
  }
  if (!Number.isInteger(entry.year) || entry.year < 2000 || entry.year > 2100) {
    throw new IftaRequestError('Year is out of range.');
  }
  if (entry.sourceNote.trim() === '') {
    throw new IftaRequestError(
      'A rate needs a source note. It is the only input to this return that no document supplies, so where it was read from is the whole of its provenance.',
    );
  }
  if (entry.enteredBy.trim() === '') throw new IftaRequestError('enteredBy is required.');
  assertRate(entry.ratePerGallon, 'ratePerGallon');
  if (entry.surchargePerGallon !== undefined) assertRate(entry.surchargePerGallon, 'surchargePerGallon');

  await query(
    `INSERT INTO accounting.ifta_rate
       (jurisdiction, fuel_type, period_year, period_quarter, rate_per_gallon, surcharge_per_gallon, source_note, entered_by)
     VALUES ($1, 'diesel', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (jurisdiction, fuel_type, period_year, period_quarter) DO UPDATE
        SET rate_per_gallon = EXCLUDED.rate_per_gallon,
            surcharge_per_gallon = EXCLUDED.surcharge_per_gallon,
            source_note = EXCLUDED.source_note,
            entered_by = EXCLUDED.entered_by,
            entered_at = now()`,
    [
      jurisdiction,
      entry.year,
      entry.quarter,
      entry.ratePerGallon,
      entry.surchargePerGallon ?? '0',
      entry.sourceNote.trim(),
      entry.enteredBy.trim(),
    ],
  );
}

function assertRate(value: string, field: string): void {
  if (!/^\d+(\.\d{1,5})?$/.test(value.trim())) {
    throw new IftaRequestError(
      `${field} must be a non-negative decimal with at most 5 places (dollars per gallon), got ${JSON.stringify(value)}.`,
    );
  }
}

/**
 * Imports a whole published rate matrix for one quarter.
 *
 * The alternative — typing 48 jurisdictions by hand each quarter — is not
 * a real alternative: it is the step that would not get done, and a
 * jurisdiction with no rate has its line withheld from the return.
 *
 * Every rate still carries the same provenance a typed one does: who
 * imported it and where it came from. `parseIftaRateMatrix` refuses any
 * figure outside the plausible band for a US diesel rate before it gets
 * here — see that module for the wrong-column failure that guard exists
 * to catch.
 */
export interface ImportMatrixResult {
  imported: number;
  rejected: RateMatrixParse['rejected'];
  problems: string[];
}

export async function importRateMatrix(input: {
  text: string;
  year: number;
  quarter: number;
  sourceNote: string;
  enteredBy: string;
}): Promise<ImportMatrixResult> {
  if (input.sourceNote.trim() === '') {
    throw new IftaRequestError(
      'A rate import needs a source note naming where the matrix came from — it is the whole of these figures\' provenance.',
    );
  }
  if (input.enteredBy.trim() === '') throw new IftaRequestError('enteredBy is required.');

  const parsed = parseIftaRateMatrix(input.text);
  if (parsed.rates.length === 0) {
    throw new IftaRequestError(
      `No usable rates were found. ${parsed.problems.join(' ')}`.trim(),
    );
  }

  for (const r of parsed.rates) {
    await upsertRate({
      jurisdiction: r.jurisdiction,
      year: input.year,
      quarter: input.quarter,
      ratePerGallon: r.ratePerGallon,
      surchargePerGallon: r.surchargePerGallon,
      // A zero rate that is genuinely zero says so, so nobody later reads
      // it as a placeholder somebody forgot to fill in.
      sourceNote: r.noFuelTax
        ? `${input.sourceNote.trim()} — weight-mile jurisdiction, no IFTA fuel tax`
        : input.sourceNote.trim(),
      enteredBy: input.enteredBy.trim(),
    });
  }

  return { imported: parsed.rates.length, rejected: parsed.rejected, problems: parsed.problems };
}

/* --------------------------------------------------------------------- */
/* Saving a return                                                       */
/* --------------------------------------------------------------------- */

export interface SaveIftaResult {
  calcRunId: string;
  lineCount: number;
}

/**
 * Persists a computed return as a `calc_run` plus its `ifta_liability`
 * lines and the documents it was read from.
 *
 * Three refusals, and all three are the schema's rather than this
 * function's opinion:
 *
 *  - **An accrual cannot be saved.** `ifta_liability.period_quarter` is NOT
 *    NULL because this is the returns table. A weekly figure is real and
 *    worth seeing; it is not a return, and storing it here would let it be
 *    read back later as one.
 *  - **A return is saved for one entity.** IFTA is filed per licensee.
 *    `entity_id` is NOT NULL, so a group-wide view is a view, not a filing.
 *  - **A return with withheld lines is not saved.** If the engine reported
 *    a jurisdiction whose rate is missing, the total is knowably short.
 *    Saving it would put an incomplete figure in the table that later reads
 *    as final.
 */
export async function saveIftaReturn(view: IftaReturnView, savedBy: string): Promise<SaveIftaResult> {
  if (view.result === null) {
    throw new IftaRequestError(view.blocked ?? 'There is no return to save.');
  }
  if (view.periodKind !== 'quarter') {
    throw new IftaRequestError(
      `${view.from} to ${view.to} is not a calendar quarter, so this is an accrual — what is building up — not a return. Accruals are not saved as filings.`,
    );
  }
  if (view.entityId === null) {
    throw new IftaRequestError(
      'A return is filed by one licensee. Pick an entity before saving; the group-wide figure is a view, not a filing.',
    );
  }
  const withheld = view.result.problems.filter((p) => p.includes('no tax rate on file'));
  if (withheld.length > 0) {
    throw new IftaRequestError(
      `This return is knowably short by ${withheld.length} jurisdiction${withheld.length === 1 ? '' : 's'} with no rate on file. Enter the missing rates first — saving it now would file an incomplete figure that reads as final later.`,
    );
  }
  if (savedBy.trim() === '') throw new IftaRequestError('savedBy is required.');

  const result = view.result;
  const inputsHash = createHash('sha256')
    .update(
      JSON.stringify({
        from: view.from,
        to: view.to,
        entityId: view.entityId,
        fleetMpg: result.fleetMpg,
        lines: result.lines,
      }),
    )
    .digest('hex');

  const calcRunId = randomUUID();
  const documentIds = view.sources.mileageDocuments
    .filter((d) => d.excludedReason === null)
    .map((d) => d.documentId);

  const baseRows = await query<{ ifta_base_jurisdiction: string | null }>(
    `SELECT ifta_base_jurisdiction FROM accounting.entity WHERE entity_id = $1`,
    [view.entityId],
  );
  const baseJurisdiction = baseRows[0]?.ifta_base_jurisdiction ?? null;

  await withTransaction(async (q) => {
    await q(
      `INSERT INTO accounting.calc_run
         (calc_run_id, engine, engine_version, period_start, period_end, inputs_hash, status, finished_at)
       VALUES ($1, 'ifta', $2, $3::date, $4::date, $5, 'succeeded', now())`,
      [calcRunId, ENGINE_VERSION, view.from, view.to, inputsHash],
    );

    for (const line of result.lines) {
      await q(
        `INSERT INTO accounting.ifta_liability
           (calc_run_id, entity_id, truck_id, period_year, period_quarter, jurisdiction,
            total_miles, taxable_miles, taxable_gallons, tax_paid_gallons,
            rate_per_gallon, surcharge_per_gallon, tax_due, surcharge_due, net_liability, fleet_mpg,
            base_jurisdiction)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          calcRunId,
          view.entityId,
          view.quarter.year,
          view.quarter.quarter,
          line.jurisdiction,
          line.totalMiles,
          line.taxableMiles,
          line.taxableGallons,
          line.taxPaidGallons,
          line.ratePerGallon,
          line.surchargePerGallon,
          line.taxDue,
          line.surchargeDue,
          line.totalDue,
          result.fleetMpg,
          baseJurisdiction,
        ],
      );
    }

    for (const documentId of documentIds) {
      await q(
        `INSERT INTO accounting.ifta_run_source (calc_run_id, document_id, role)
         VALUES ($1, $2, 'mileage') ON CONFLICT DO NOTHING`,
        [calcRunId, documentId],
      );
    }
  });

  return { calcRunId, lineCount: result.lines.length };
}

export interface SavedReturnSummary {
  calcRunId: string;
  entityId: string;
  year: number;
  quarter: number;
  periodStart: string;
  periodEnd: string;
  lineCount: number;
  netDue: string;
  savedAt: string;
}

export async function listSavedReturns(limit = 25): Promise<SavedReturnSummary[]> {
  const rows = await query<{
    calc_run_id: string;
    entity_id: string;
    period_year: number;
    period_quarter: number;
    period_start: Date;
    period_end: Date;
    line_count: string;
    net_due: string;
    started_at: Date;
  }>(
    `SELECT r.calc_run_id, l.entity_id, l.period_year, l.period_quarter,
            r.period_start, r.period_end,
            count(*) AS line_count, sum(l.net_liability)::text AS net_due, r.started_at
       FROM accounting.calc_run r
       JOIN accounting.ifta_liability l ON l.calc_run_id = r.calc_run_id
      WHERE r.engine = 'ifta'
      GROUP BY r.calc_run_id, l.entity_id, l.period_year, l.period_quarter, r.period_start, r.period_end, r.started_at
      ORDER BY r.started_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    calcRunId: r.calc_run_id,
    entityId: r.entity_id,
    year: r.period_year,
    quarter: r.period_quarter,
    periodStart: isoDate(r.period_start),
    periodEnd: isoDate(r.period_end),
    lineCount: Number(r.line_count),
    netDue: r.net_due,
    savedAt: new Date(r.started_at).toISOString(),
  }));
}

function isoDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
