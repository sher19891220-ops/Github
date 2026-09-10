import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractDocument } from '@/ingest/extract';
import { parseRegistrationVehicleRows } from '@/ingest/extract/registration';

// Real IRP "Vehicle Status" fleet report — never a synthetic fixture
// (CLAUDE.md §2). Referenced directly from the uploads drop rather than
// copied into the repo.
const FIXTURE_PATH = '/root/.claude/uploads/92af2792-ab83-552c-a4fd-1f7c6683f698/f1a2b581-irp_42_units.pdf';
const haveFixture = existsSync(FIXTURE_PATH);

describe.skipIf(!haveFixture)('extractDocument — real IRP registration PDF, text-layer path', () => {
  it('is sniffed as a text-layer PDF, not routed to OCR', async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    const result = await extractDocument(bytes, 'irp_42_units.pdf', 'application/pdf');
    expect(result.status).toBe('ok');
    expect(result.kind).toBe('pdf_text');
    expect(result.anyPageOcrd).toBe(false);
    expect(result.pages?.length).toBe(2); // "Page 1 of 2" / "Page 2 of 2" on the document itself
  });

  it('recovers all 42 VINs exactly, every one passing structural validation', async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    const result = await extractDocument(bytes, 'irp_42_units.pdf', 'application/pdf');
    const text = result.pages!.map((p) => p.text).join('\n');
    const rows = parseRegistrationVehicleRows(text);

    // The document's own header states "Total Units : 42".
    expect(text).toMatch(/Total Units\s*:\s*42/);
    expect(rows).toHaveLength(42);

    for (const row of rows) {
      expect(row.vin.value).not.toBeNull();
      expect(row.vin.value).toHaveLength(17);
    }

    // A clean text-layer read: no correction was needed anywhere, and
    // nothing should be flagged for review on structural grounds.
    const corrected = rows.filter((r) => r.vin.corrected);
    const flagged = rows.filter((r) => r.vin.needsReview);
    expect(corrected).toHaveLength(0);
    expect(flagged).toHaveLength(0);

    // No VIN contains I, O or Q.
    for (const row of rows) {
      expect(row.vin.illegalChars).toHaveLength(0);
    }

    // VINs are unique across the fleet.
    const vins = rows.map((r) => r.vin.value);
    expect(new Set(vins).size).toBe(42);

    // eslint-disable-next-line no-console
    console.log('text-layer VIN recovery: 42/42 exact (100%)');
  });
});

describe.skipIf(!haveFixture)('extractDocument — unsupported/failure paths stay honest', () => {
  it('rejects a non-PDF, non-XLSX, non-image, non-text file with a clear reason', async () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x00, 0x01, 0x02, 0x03]);
    const result = await extractDocument(garbage, 'mystery.dat', 'application/octet-stream');
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(result.pages).toBeNull();
    expect(result.sheets).toBeNull();
  });

  it('rejects an empty file rather than returning an empty-but-ok result', async () => {
    const result = await extractDocument(Buffer.alloc(0), 'empty.pdf', 'application/pdf');
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });
});
