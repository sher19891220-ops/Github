/**
 * Typing a figure in, and correcting one afterwards.
 *
 * This is the path that makes every row of `docs/INTAKE-MATRIX.md`
 * available today rather than when a connector lands: maintenance a shop
 * quoted by phone, a factoring status read off a portal, IFTA miles
 * copied from a Samsara screen, the intercompany receivable somebody wants
 * to book now and reconcile later.
 *
 * Two rules do all the work here.
 *
 * **A typed figure names a person and a basis.** Not because a form field
 * is nice to have, but because `provenance_matches_kind` will reject the
 * insert otherwise. There is no way to add a number to this ledger that
 * nobody stands behind, and that is the point.
 *
 * **Nothing is ever overwritten.** The ledger is append-only by trigger, so
 * a correction is a reversing entry plus a fresh one. What somebody
 * believed in April survives being wrong in May, which is the only reason
 * a variance can be found later at all.
 */
import type { Decimal, IsoDate, LedgerEntry, ManualAttestation } from '@/contract/types';
import { query, withTransaction } from '@/db/pool';
import { LEDGER_ENTRY_COLUMNS_SQL, mapDbRowToLedgerEntry } from './mappers';

export class ManualEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualEntryError';
  }
}

export class EntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`ledger entry ${entryId} not found`);
    this.name = 'EntryNotFoundError';
  }
}

export interface ManualEntryInput {
  entityId: string;
  accrualDate: IsoDate;
  categoryId: string;
  /** Signed, ledger convention: positive in, negative out. */
  amount: Decimal;
  truckId?: string | null;
  driverId?: string | null;
  unitNumber?: string | null;
  unitType?: 'truck' | 'trailer' | 'other' | 'unknown';
  chargedTo?: 'company' | 'driver' | 'split' | 'unknown';
  quantity?: Decimal | null;
  jurisdiction?: string | null;
  memo?: string | null;

  /** Who is standing behind this figure, and what they are going on. */
  assertedBy: string;
  basis: string;
}

const MONEY = /^-?\d{1,12}(\.\d{1,2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validate(input: ManualEntryInput): void {
  if (!MONEY.test(input.amount.trim())) {
    throw new ManualEntryError(
      `Amount must be a decimal with at most two places, signed (negative for money out). Got ${JSON.stringify(input.amount)}.`,
    );
  }
  if (!ISO_DATE.test(input.accrualDate)) {
    throw new ManualEntryError('Accrual date must be YYYY-MM-DD — the day the money belongs to.');
  }
  if (input.assertedBy.trim().length === 0) {
    throw new ManualEntryError('Name who is asserting this figure. A service account is not a person.');
  }
  if (input.basis.trim().length === 0) {
    throw new ManualEntryError(
      'Say what this is based on — "shop quoted by phone", "read off the Samsara screen". A figure with no stated basis is a guess with a name attached.',
    );
  }
}

/**
 * Records the attestation and the entry together. If the entry fails any
 * constraint the attestation must not survive it, or the table fills with
 * assertions about numbers that were never posted.
 */
export async function createManualEntry(
  input: ManualEntryInput,
  postedBy: string,
): Promise<{ entry: LedgerEntry; attestation: ManualAttestation }> {
  validate(input);

  // A real transaction, not `query('BEGIN')`: the pool hands out a
  // different connection per call, so BEGIN and COMMIT issued that way can
  // land on different sessions and the rollback protects nothing. This
  // matters here specifically — a failed entry insert must not leave an
  // attestation behind asserting a figure that was never posted.
  return withTransaction(async (q) => {
    const attRows = (await q(
      `INSERT INTO accounting.manual_attestation (asserted_by, basis)
       VALUES ($1, $2)
       RETURNING attestation_id, asserted_by,
                 to_char(asserted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS asserted_at,
                 basis`,
      [input.assertedBy.trim(), input.basis.trim()],
    )) as unknown as { attestation_id: string; asserted_by: string; asserted_at: string; basis: string }[];
    const att = attRows[0]!;

    const entryRows = (await q(
      `INSERT INTO accounting.ledger_entry
         (entity_id, truck_id, driver_id, accrual_date, category_id, amount,
          quantity, jurisdiction, unit_type, unit_number, charged_to,
          source_kind, attestation_id, memo, posted_by)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8,
               COALESCE($9::accounting.unit_type, 'unknown'), $10,
               COALESCE($11::accounting.charged_to, 'company'),
               'manual', $12, $13, $14)
       RETURNING ${LEDGER_ENTRY_COLUMNS_SQL}`,
      [
        input.entityId,
        input.truckId ?? null,
        input.driverId ?? null,
        input.accrualDate,
        input.categoryId,
        input.amount,
        input.quantity ?? null,
        input.jurisdiction ?? null,
        input.unitType ?? null,
        input.unitNumber ?? null,
        input.chargedTo ?? null,
        att.attestation_id,
        input.memo ?? null,
        postedBy,
      ],
    )) as unknown as Record<string, unknown>[];

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      entry: mapDbRowToLedgerEntry(entryRows[0] as any),
      attestation: {
        attestationId: att.attestation_id,
        assertedBy: att.asserted_by,
        assertedAt: att.asserted_at,
        basis: att.basis,
        supersededByDocumentId: null,
        supersededAt: null,
      },
    };
  });
}

/**
 * Corrects a posted figure the only way an append-only ledger allows: a
 * reversing entry that cancels the original, then a fresh entry for what it
 * should have been.
 *
 * Both survive. Somebody reading the account in six months sees that a
 * number was booked, found wrong, and replaced — which is the difference
 * between an audit trail and a number that has simply always been this.
 */
export async function correctEntry(
  entryId: string,
  replacement: { amount: Decimal; memo?: string | null },
  correctedBy: string,
  basis: string,
): Promise<{ reversal: LedgerEntry; replacement: LedgerEntry }> {
  if (!MONEY.test(replacement.amount.trim())) {
    throw new ManualEntryError('The corrected amount must be a signed decimal with at most two places.');
  }
  if (basis.trim().length === 0) {
    throw new ManualEntryError('Say why this figure is being corrected.');
  }

  const originals = (await query(
    `SELECT ${LEDGER_ENTRY_COLUMNS_SQL}, unit_type, unit_number, charged_to
       FROM accounting.ledger_entry WHERE entry_id = $1`,
    [entryId],
  )) as unknown as Record<string, unknown>[];
  const original = originals[0];
  if (!original) throw new EntryNotFoundError(entryId);

  const originalAmount = String(original.amount);
  const negated = originalAmount.startsWith('-') ? originalAmount.slice(1) : `-${originalAmount}`;

  // Same reasoning as above: the reversal and its replacement are one act.
  // Half of a correction on the books is worse than no correction.
  return withTransaction(async (q) => {
    // The reversal is an 'adjustment': it points at what it undoes, which
    // is exactly what that source_kind is for.
    const revRows = (await q(
      `INSERT INTO accounting.ledger_entry
         (entity_id, truck_id, driver_id, accrual_date, category_id, amount,
          quantity, jurisdiction, unit_type, unit_number, charged_to,
          source_kind, reverses_entry_id, memo, posted_by)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,'adjustment',$12,$13,$14)
       RETURNING ${LEDGER_ENTRY_COLUMNS_SQL}`,
      [
        original.entity_id,
        original.truck_id,
        original.driver_id,
        original.accrual_date,
        original.category_id,
        negated,
        original.quantity,
        original.jurisdiction,
        original.unit_type,
        original.unit_number,
        original.charged_to,
        entryId,
        `Reverses ${entryId}: ${basis.trim()}`,
        correctedBy,
      ],
    )) as unknown as Record<string, unknown>[];

    const attRows = (await q(
      `INSERT INTO accounting.manual_attestation (asserted_by, basis)
       VALUES ($1, $2) RETURNING attestation_id`,
      [correctedBy, `Correction of ${entryId}: ${basis.trim()}`],
    )) as unknown as { attestation_id: string }[];

    const newRows = (await q(
      `INSERT INTO accounting.ledger_entry
         (entity_id, truck_id, driver_id, accrual_date, category_id, amount,
          quantity, jurisdiction, unit_type, unit_number, charged_to,
          source_kind, attestation_id, memo, posted_by)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,'manual',$12,$13,$14)
       RETURNING ${LEDGER_ENTRY_COLUMNS_SQL}`,
      [
        original.entity_id,
        original.truck_id,
        original.driver_id,
        original.accrual_date,
        original.category_id,
        replacement.amount,
        original.quantity,
        original.jurisdiction,
        original.unit_type,
        original.unit_number,
        original.charged_to,
        attRows[0]!.attestation_id,
        replacement.memo ?? `Corrected value for ${entryId}`,
        correctedBy,
      ],
    )) as unknown as Record<string, unknown>[];

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reversal: mapDbRowToLedgerEntry(revRows[0] as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      replacement: mapDbRowToLedgerEntry(newRows[0] as any),
    };
  });
}

/**
 * Marks what a person asserted as now proven (or disproven) by a real
 * document. The attestation is kept: "we believed $1,200 on a phone call,
 * the invoice said $1,450" is what the reconciliation screen exists to
 * surface, and deleting the first figure destroys the only evidence that a
 * variance ever existed.
 */
export async function supersedeAttestation(
  attestationId: string,
  documentId: string,
): Promise<ManualAttestation> {
  const rows = (await query(
    `UPDATE accounting.manual_attestation
        SET superseded_by_document_id = $2, superseded_at = now()
      WHERE attestation_id = $1
      RETURNING attestation_id, asserted_by,
                to_char(asserted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS asserted_at,
                basis, superseded_by_document_id,
                to_char(superseded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS superseded_at`,
    [attestationId, documentId],
  )) as unknown as {
    attestation_id: string;
    asserted_by: string;
    asserted_at: string;
    basis: string;
    superseded_by_document_id: string | null;
    superseded_at: string | null;
  }[];

  const r = rows[0];
  if (!r) throw new ManualEntryError(`attestation ${attestationId} not found`);
  return {
    attestationId: r.attestation_id,
    assertedBy: r.asserted_by,
    assertedAt: r.asserted_at,
    basis: r.basis,
    supersededByDocumentId: r.superseded_by_document_id,
    supersededAt: r.superseded_at,
  };
}

/**
 * How much of a period's money is a person's word rather than a document.
 *
 * The number a dashboard needs in order not to lie: a total that is 90%
 * documented and 10% asserted is a different number from one fully
 * documented, and flattening the two is exactly what the caveat band exists
 * to prevent.
 */
export async function attestedShare(
  from: IsoDate,
  to: IsoDate,
  entityId?: string,
): Promise<{ attestedTotal: Decimal; attestedCount: number; totalCount: number }> {
  const params: unknown[] = [from, to];
  let entityClause = '';
  if (entityId) {
    params.push(entityId);
    entityClause = `AND entity_id = $${params.length}`;
  }
  const rows = (await query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE source_kind = 'manual'), 0)::text AS attested_total,
            count(*) FILTER (WHERE source_kind = 'manual') AS attested_count,
            count(*) AS total_count
       FROM accounting.ledger_entry
      WHERE accrual_date BETWEEN $1::date AND $2::date ${entityClause}`,
    params,
  )) as unknown as { attested_total: string; attested_count: string; total_count: string }[];

  const r = rows[0]!;
  return {
    attestedTotal: r.attested_total,
    attestedCount: Number(r.attested_count),
    totalCount: Number(r.total_count),
  };
}
