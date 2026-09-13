/**
 * Accounting does not control what a vendor sends.
 *
 * A fuel statement is a CSV one month, a PDF the next, and a photo of a
 * printout when someone is at a truck stop. The extraction layer already read
 * all of those — routing on the bytes, never the extension — but the upload
 * path refused everything except `registration`, so a PDF statement uploaded,
 * extracted, and then died on "no binary parser implemented". These pin the
 * plumbing that now hands extracted text to the same parser the text path
 * uses, and the one rule that makes OCR safe to accept at all.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createDocument, getDocumentRows, getDocumentSummary } from '@/db/repo/documents';
import { ensureBaseFixtures } from './helpers';

const STATEMENT_LINES = (unit: string) => [
  'EFS LLC - Fuel Statement',
  'Billing period 03/01/2026 - 03/31/2026',
  'Tran Date,Invoice,Unit,Location Name,State,Product,Qty,Unit Price,Net Amount',
  `03/15/2026,INV-A1,${unit},PILOT COLUMBUS,OH,ULSD,180.50,3.799,685.72`,
  `03/16/2026,INV-A2,${unit},LOVES FISHKILL,IN,ULSD,142.00,3.599,511.06`,
];

/** A single-page PDF with a real text layer, built by hand so the test needs
 *  no external converter and the bytes are identical on every machine. */
function pdfWithTextLayer(lines: readonly string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const body = `BT /F1 9 Tf 36 750 Td 12 TL\n${lines.map((l) => `(${esc(l)}) Tj T*`).join('\n')}\nET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function upload(fileName: string, mimeType: string, bytes: Buffer) {
  const doc = await createDocument({ docType: 'fuel_card', fileName, mimeType, bytes, uploadedBy: 'accounting@fleet' });
  // The binary path is fire-and-forget on purpose (OCR can take minutes), so
  // poll the document the way the upload screen does. The budget is generous
  // because the suite runs files in parallel and OCR is CPU-bound: 20s was
  // enough alone and not enough under load.
  for (let i = 0; i < 480; i += 1) {
    const s = await getDocumentSummary(doc.documentId);
    if (s && s.parseStatus !== 'pending') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { id: doc.documentId, summary: await getDocumentSummary(doc.documentId), rows: await getDocumentRows(doc.documentId) };
}

const uniq = () => `U${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;

/** Renders a PDF to a PNG, giving a raster image with no text layer — a
 *  stand-in for a photo. Returns null where poppler is not installed, so the
 *  suite still runs on a machine without it rather than failing for the wrong
 *  reason. */
async function rasterize(pdf: Buffer): Promise<Buffer | null> {
  const { mkdtemp, writeFile, readFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const dir = await mkdtemp(join(tmpdir(), 'ocrtest-'));
  const src = join(dir, 'in.pdf');
  await writeFile(src, pdf);
  try {
    await promisify(execFile)('pdftoppm', ['-png', '-r', '200', src, join(dir, 'page')]);
  } catch {
    return null;
  }
  const png = (await readdir(dir)).find((f) => f.endsWith('.png'));
  return png ? readFile(join(dir, png)) : null;
}

describe('a fuel statement is accepted in whatever shape the vendor sent it', () => {
  beforeAll(async () => { await ensureBaseFixtures(); });

  it('reads a PDF with a text layer, with the figures intact', async () => {
    const unit = uniq();
    const r = await upload(`efs-${unit}.pdf`, 'application/pdf', pdfWithTextLayer(STATEMENT_LINES(unit)));
    expect(r.summary?.parseStatus).toBe('parsed');
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => x.amount)).toEqual(['-685.72', '-511.06']);
    expect(r.rows.map((x) => x.jurisdiction)).toEqual(['OH', 'IN']);
    expect(r.rows[0]!.accrualDate).toBe('2026-03-15');
  }, 30_000);

  it('reads an XLSX workbook, which arrives as cells rather than lines', async () => {
    const unit = uniq();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['Tran Date', 'Invoice', 'Unit', 'Location Name', 'State', 'Product', 'Qty', 'Unit Price', 'Net Amount']);
    ws.addRow(['03/20/2026', 'INV-B1', unit, 'PILOT AKRON', 'OH', 'ULSD', '200.00', '3.850', '770.00']);
    const r = await upload(`efs-${unit}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.summary?.parseStatus).toBe('parsed');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.amount).toBe('-770.00');
    expect(r.rows[0]!.quantity).toBe('200.0000');
  }, 30_000);

  it('does NOT flag a text-layer PDF as OCR — the warning has to mean something', async () => {
    const unit = uniq();
    const r = await upload(`efs-${unit}.pdf`, 'application/pdf', pdfWithTextLayer(STATEMENT_LINES(unit)));
    for (const row of r.rows) expect(row.reviewNotes ?? '').not.toMatch(/Read by OCR/);
  }, 30_000);

  it('reads a PHOTO by OCR and holds every row it produces for review', async () => {
    // Rendered from the PDF above, so the bytes are a raster image with no
    // text layer — exactly what a phone photo of a printout is. Measured OCR
    // recovery on a real scan was 79% (SOURCE-DISCOVERY §14), so a figure
    // here is a reading of a picture of a number. It may be right; it has not
    // been checked, and nothing unchecked reaches the ledger.
    const unit = uniq();
    const pdf = pdfWithTextLayer(STATEMENT_LINES(unit));
    const png = await rasterize(pdf);
    if (png === null) return; // no pdftoppm on this machine

    const r = await upload(`efs-${unit}-photo.png`, 'image/png', png);
    expect(r.summary?.parseStatus).toBe('parsed');
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.status).toBe('under_review');
      expect(row.reviewNotes ?? '').toMatch(/Read by OCR/);
    }
    // And it read the figures, not just noise.
    expect(r.rows.map((x) => x.amount)).toContain('-685.72');
  }, 120_000);

  it('says plainly when a file was read but held nothing to parse', async () => {
    const r = await upload('blank.pdf', 'application/pdf', pdfWithTextLayer(['']));
    expect(r.summary?.parseStatus).toBe('failed');
    expect(r.summary?.parseError ?? '').toMatch(/no text to parse|could not/i);
  }, 30_000);
});
