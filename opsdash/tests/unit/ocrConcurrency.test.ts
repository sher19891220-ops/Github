/**
 * Concurrent OCR must not hang.
 *
 * Tesseract links against OpenMP and sizes its thread pool to the core
 * count *per process*. Several OCR jobs at once — concurrent uploads in
 * production, parallel test files in CI — oversubscribe the machine and
 * collapse. Measured on a 4-core container with one 200dpi page: a single
 * process takes ~2s either way, eight at once take ~3.4s with
 * OMP_THREAD_LIMIT=1 and did not finish inside ten minutes without it.
 *
 * This was found as an intermittent test failure (a 120s OCR timeout that
 * appeared in one run out of four) and is a production bug, not a test
 * artefact: the upload path shells out to the same binary.
 *
 * The assertion is wall-clock because the defect is wall-clock. A timeout
 * well under the unfixed behaviour and well over the fixed behaviour
 * separates the two without being tight enough to fail on a slow runner.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ocrImageBytes } from '../../src/ingest/extract/ocr';

const execFileAsync = promisify(execFile);

async function haveTools(): Promise<boolean> {
  try {
    await execFileAsync('tesseract', ['--version']);
    await execFileAsync('pdftoppm', ['-v']);
    return true;
  } catch {
    return false;
  }
}

/** A page of plausible fuel-statement lines, rendered to PNG via poppler so
 *  the bytes are a real raster with no text layer. */
async function statementPng(): Promise<Buffer> {
  const { mkdtemp, writeFile, readFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lines = Array.from(
    { length: 40 },
    (_, i) => `04/0${(i % 9) + 1}/2026  UNIT 80${String(i).padStart(2, '0')}  DIESEL  123.456 GAL  $-685.72`,
  );
  const content = `BT /F1 9 Tf 20 760 Td 11 TL\n${lines.map((l) => `(${l}) Tj T*\n`).join('')}ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const dir = await mkdtemp(join(tmpdir(), 'ocrconc-'));
  const src = join(dir, 'in.pdf');
  await writeFile(src, Buffer.from(pdf, 'latin1'));
  await execFileAsync('pdftoppm', ['-png', '-r', '200', '-f', '1', '-l', '1', src, join(dir, 'page')]);
  const png = (await readdir(dir)).find((f) => f.endsWith('.png'));
  if (!png) throw new Error('pdftoppm produced no PNG');
  return readFile(join(dir, png));
}

describe('OCR under concurrency', () => {
  it('reads eight pages at once without collapsing', async () => {
    if (!(await haveTools())) return; // poppler/tesseract not installed here
    const png = await statementPng();

    const started = Date.now();
    const texts = await Promise.all(Array.from({ length: 8 }, () => ocrImageBytes(png, '.png')));
    const elapsed = Date.now() - started;

    // It did the work, not just returned fast.
    for (const t of texts) expect(t).toMatch(/DIESEL/);
    // Eight concurrent pages land in seconds when the thread pool is capped.
    // Without the cap this does not finish at all, so any bound below the
    // suite timeout is a true separator; 90s leaves room for a slow runner.
    expect(elapsed).toBeLessThan(90_000);
  }, 120_000);
});
