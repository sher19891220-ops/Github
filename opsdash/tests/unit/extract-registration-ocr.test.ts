import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractDocument } from '@/ingest/extract';
import { getPdfPageCount, extractPdfTextLayer, materializePdf, runTool } from '@/ingest/extract/pdf';
import { parseRegistrationVehicleRows } from '@/ingest/extract/registration';

// Same real IRP fleet report as extract-registration-pdf.test.ts. This file
// simulates a scan of it end to end (render to image, OCR, discard the real
// text layer) exactly as SOURCE-DISCOVERY.md section 14 measured, then
// reports what VIN check-digit validation recovers -- never a synthetic
// fixture.
//
// Everything below runs inside a single `it()` sharing one set of rendered
// pages: rendering + tesseract is real subprocess work (never mocked, per
// CLAUDE.md §2), this sandbox runs many concurrent test files/agents, and
// re-rendering/re-OCRing the same page for a separate "does the generic
// image entry point work" check would roughly double an already expensive
// test for no extra signal — so the page-1 PNG bytes are rendered once and
// reused for both the low-level per-page OCR path and the top-level
// `extractDocument` standalone-image path.
const FIXTURE_PATH = '/root/.claude/uploads/92af2792-ab83-552c-a4fd-1f7c6683f698/f1a2b581-irp_42_units.pdf';
const haveFixture = existsSync(FIXTURE_PATH);

describe.skipIf(!haveFixture)('scanned-path extraction -- real document, OCR only, text layer discarded', () => {
  it(
    'recovers VINs via OCR + check-digit validation, and the generic image entry point reads the same page',
    async () => {
      const bytes = readFileSync(FIXTURE_PATH);
      const ws = await materializePdf(bytes);
      let truthRows: ReturnType<typeof parseRegistrationVehicleRows>;
      let ocrRows: ReturnType<typeof parseRegistrationVehicleRows>;
      let page1PngBytes: Buffer;
      try {
        const pageCount = await getPdfPageCount(ws.pdfPath);

        // Ground truth: the same document's real text layer, used only to
        // measure OCR accuracy, never fed into the OCR path itself.
        const textLayer = await extractPdfTextLayer(ws.pdfPath, pageCount);
        truthRows = parseRegistrationVehicleRows(textLayer.pages.map((p) => p.text).join('\n'));

        // The scan simulation: render each page to a PNG once, then OCR
        // that same file directly (no re-rendering). The text layer is
        // never consulted for this half of the test. Page 1's rendered PNG
        // bytes are kept for the generic-image-path check below instead of
        // rendering it a second time.
        let ocrText = '';
        for (let p = 1; p <= pageCount; p++) {
          const prefix = `${ws.dir}/rendered-${p}`;
          await runTool('pdftoppm', ['-png', '-r', '200', '-f', String(p), '-l', String(p), ws.pdfPath, prefix]);
          const pngPath = `${prefix}-${p}.png`;
          if (p === 1) page1PngBytes = readFileSync(pngPath);
          const { stdout } = await runTool('tesseract', [pngPath, 'stdout', '--psm', '6']);
          ocrText += `${stdout}\n`;
        }
        ocrRows = parseRegistrationVehicleRows(ocrText);
      } finally {
        await ws.cleanup();
      }

      expect(truthRows).toHaveLength(42);
      // OCR table structure recovery: the fixed-field-width row parser
      // should still find (close to) all 42 rows even through OCR noise --
      // SOURCE-DISCOVERY.md section 14 measured "document structure
      // recovered: fully" separately from character-level VIN accuracy.
      expect(ocrRows.length).toBeGreaterThanOrEqual(40);

      const truthByUnit = new Map(truthRows.map((r) => [r.unit.value, r.vin.value]));

      let rawExact = 0;
      let correctedExact = 0;
      let stillWrongAfterCorrection = 0;
      let matchedRows = 0;

      for (const row of ocrRows) {
        const truth = truthByUnit.get(row.unit.value);
        if (!truth) continue; // OCR misread the unit number itself; not what this test measures
        matchedRows++;

        // "Raw" = exactly what OCR printed for the VIN column, before any
        // validation/correction touched it.
        if (row.vin.original === truth) rawExact++;
        if (row.vin.value === truth) correctedExact++;
        if (row.vin.value !== truth) {
          // Anything still wrong after validation MUST be flagged -- a
          // silent wrong answer is exactly what section 14 exists to
          // prevent.
          expect(row.vin.needsReview).toBe(true);
          if (!row.vin.needsReview) stillWrongAfterCorrection++;
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        'scanned-path VIN recovery (real document, ' + matchedRows + ' rows matched by unit#): ' +
          'raw exact = ' + rawExact + '/' + matchedRows +
          ', after check-digit validation/correction = ' + correctedExact + '/' + matchedRows,
      );

      expect(stillWrongAfterCorrection).toBe(0);
      // Correction must not make things worse than the raw OCR text.
      expect(correctedExact).toBeGreaterThanOrEqual(rawExact);

      // Generic image entry point: the same rendered page bytes, fed
      // through `extractDocument` with a deliberately misleading
      // extension/mime, should be sniffed as an image (content wins over
      // extension) and produce the same kind of readable table text.
      const imageResult = await extractDocument(page1PngBytes!, 'page1.pdf', 'application/pdf');
      expect(imageResult.status).toBe('ok');
      expect(imageResult.kind).toBe('image');
      expect(imageResult.anyPageOcrd).toBe(true);
      const imageRows = parseRegistrationVehicleRows(imageResult.pages![0]!.text);
      expect(imageRows.length).toBeGreaterThan(15);
    },
    // Generous timeout: this spawns real `pdftoppm`/`tesseract` subprocesses
    // (2 PDF pages, rendered once and OCR'd once each), and this environment
    // has been observed under very heavy concurrent load from other agent
    // sessions sharing the same host — see the final report for measured
    // pass times under normal load (a few seconds) vs. this ceiling.
    300_000,
  );
});
