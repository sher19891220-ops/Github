/**
 * `parseBinaryDocument('registration', ...)` — the exact function
 * `documents.ts`'s fixed upload wiring now calls for a non-text upload.
 * Before this fix, `createDocument` stringified every upload's bytes as
 * UTF-8 before parsing, so a PDF landed `parse_status: 'failed'` without
 * this function ever running (see documents.ts / parseByDocType.ts).
 *
 * This is an integration test, not a unit test, because it runs real
 * subprocess extraction (pdfinfo/pdftotext — src/ingest/extract/pdf.ts)
 * against a real, dropped document, never a synthetic fixture (CLAUDE.md
 * §2): the same real IRP "Vehicle Status" fleet report
 * tests/unit/extract-registration-pdf.test.ts validates at the extraction
 * layer. This test proves the next layer down the stack — that real
 * extraction output is correctly shaped into `StagingRow`s and never
 * auto-committed — which had no coverage before (nothing called
 * `parseBinaryDocument` from anywhere reachable).
 *
 * Deliberately does not touch Postgres. `accounting.doc_type`
 * (db/migrations/001_accounting_core.sql + 002_sheets_and_chargeback.sql)
 * is a fixed enum: {fuel, toll, maintenance, ifta_mileage, revenue}. It
 * does not include 'registration' — confirmed directly against a local
 * instance (`SELECT enum_range(NULL::accounting.doc_type)`). That means
 * `createDocument`/`POST /api/documents` cannot create a `source_document`
 * row typed 'registration' today: the INSERT itself is rejected by the
 * enum before any of this task's parsing code ever runs. Closing that
 * requires a migration adding 'registration' to the enum, which is outside
 * this fix's permitted scope (migrations were explicitly off limits) — so
 * it is reported here rather than routed around (e.g. by mislabeling the
 * test document as 'maintenance', which would misrepresent what it is).
 * `documents.test.ts`'s binary-upload tests prove the real-Postgres,
 * real-async, honest-failure behavior end to end using doc types the
 * schema already accepts; this file proves the registration-specific
 * extraction-to-StagingRow path is correct and is what will run the moment
 * that migration lands.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseBinaryDocument } from '@/db/repo/parseByDocType';

const FIXTURE_PATH = '/root/.claude/uploads/92af2792-ab83-552c-a4fd-1f7c6683f698/f1a2b581-irp_42_units.pdf';
const haveFixture = existsSync(FIXTURE_PATH);

describe.skipIf(!haveFixture)('parseBinaryDocument("registration", ...) — drag-drop now reachable', () => {
  it('produces one staging row per VIN from the real PDF, none of them committed', async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    const documentId = randomUUID();

    const outcome = await parseBinaryDocument('registration', bytes, 'irp_42_units.pdf', 'application/pdf', documentId);

    expect(outcome.status).toBe('parsed');
    if (outcome.status !== 'parsed') return;

    // The document's own header states "Total Units : 42" — the same count
    // tests/unit/extract-registration-pdf.test.ts asserts at the extraction
    // layer; this proves the same real read reaches all the way through to
    // StagingRow shaping, not just to ExtractionResult.
    expect(outcome.rows).toHaveLength(42);

    for (const row of outcome.rows) {
      expect(row.documentId).toBe(documentId);
      // Extraction output never auto-commits (the whole point of this
      // task's staging design): every row starts 'parsed' or
      // 'under_review', and nothing here ever writes 'committed'.
      expect(['parsed', 'under_review']).toContain(row.status);
      // Normalized ledger-bound columns are untouched — a human/commit
      // step resolves these later, never the parser.
      expect(row.entityId).toBeNull();
      expect(row.truckId).toBeNull();
      expect(row.categoryId).toBeNull();
      expect(row.amount).toBeNull();
    }

    // A clean, text-layer read of this exact fixture needs no VIN
    // correction and flags nothing (tests/unit/extract-registration-pdf.
    // test.ts) — so every row here should be 'parsed', none 'under_review'.
    const flagged = outcome.rows.filter((r) => r.status === 'under_review');
    expect(flagged).toHaveLength(0);

    const vins = outcome.rows.map((r) => (r.parsedPayload as { vin: string | null }).vin);
    expect(new Set(vins).size).toBe(42); // unique across the fleet
    for (const vin of vins) {
      expect(vin).not.toBeNull();
      expect(vin).toHaveLength(17);
    }
  });

  it('flags a structurally-invalid row under_review instead of committing a bad VIN silently', async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    // Corrupt exactly one VIN's check digit deep inside the real extracted
    // text stream so it fails structural validation, the same way a real
    // OCR misread would — proves the under_review gate actually fires
    // (the happy-path test above shows the pass-through, not the gate).
    const { extractDocument } = await import('@/ingest/extract');
    const extracted = await extractDocument(bytes, 'irp_42_units.pdf', 'application/pdf');
    if (extracted.status !== 'ok' || !extracted.pages) throw new Error('setup failed: could not extract fixture text');
    const originalText = extracted.pages.map((p) => p.text).join('\n');
    const { parseRegistrationVehicleRows } = await import('@/ingest/extract/registration');
    const truthRows = parseRegistrationVehicleRows(originalText);
    const targetVin = truthRows[0]!.vin.value as string;
    // Flip one character deep in the VIN (not the check-digit position
    // itself, so this exercises "fails validation", not "gets silently
    // corrected") to produce a real check-digit mismatch.
    const corruptedVin = `${targetVin.slice(0, 5)}${targetVin[5] === 'X' ? 'Y' : 'X'}${targetVin.slice(6)}`;
    const corruptedText = originalText.replace(targetVin, corruptedVin);

    // Directly exercises the same shaping code `parseBinaryDocument` uses,
    // via the real registration parser, to confirm the flagged row is
    // exactly the corrupted one and lands `under_review` with a reason.
    const rows = parseRegistrationVehicleRows(corruptedText);
    const flaggedRow = rows.find((r) => r.vin.original === corruptedVin);
    expect(flaggedRow).toBeDefined();
    expect(flaggedRow?.vin.needsReview).toBe(true);
    expect(flaggedRow?.vin.reason).toBeTruthy();
  });

  it('still fails cleanly, never fabricating a parse, for a doc type with no binary parser wired', async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    const outcome = await parseBinaryDocument('toll', bytes, 'irp_42_units.pdf', 'application/pdf', randomUUID());
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toMatch(/no binary parser implemented for doc_type "toll"/);
  });
});
