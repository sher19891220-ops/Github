/**
 * OCR fallback: `pdftoppm` renders a PDF page to PNG, `tesseract` reads it.
 * Also used directly for dropped image files (JPEG/PNG/TIFF/WEBP).
 *
 * Tesseract is a *system* dependency (task brief) — `runTool` (pdf.ts)
 * throws `MissingToolError` with a clear message rather than letting a
 * missing binary surface as an empty string, which would look exactly like
 * "OCR ran and found nothing" instead of "OCR never ran".
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MissingToolError, materializePdf, runTool } from './pdf';

export { MissingToolError };

const DEFAULT_DPI = 200; // matches the dpi SOURCE-DISCOVERY.md §14 measured against
const DEFAULT_PSM = '6'; // "assume a single uniform block of text" — the right mode for tabular documents

/** Renders one page of a PDF already on disk to a PNG at the given dpi,
 *  returning the path to the rendered file. */
async function renderPdfPageToPng(pdfPath: string, dir: string, pageNumber: number, dpi: number): Promise<string> {
  const prefix = path.join(dir, `page-${pageNumber}`);
  await runTool('pdftoppm', ['-png', '-r', String(dpi), '-f', String(pageNumber), '-l', String(pageNumber), pdfPath, prefix]);
  const files = await readdir(dir);
  const base = path.basename(prefix);
  const match = files.find((f) => f.startsWith(base) && f.endsWith('.png'));
  if (!match) throw new Error(`pdftoppm did not produce a PNG for page ${pageNumber}.`);
  return path.join(dir, match);
}

/** Runs tesseract on an image file already on disk, capturing stdout text
 *  directly (no intermediate output file needed). */
async function ocrImageFile(imagePath: string, psm: string): Promise<string> {
  const { stdout } = await runTool('tesseract', [imagePath, 'stdout', '--psm', psm]);
  return stdout;
}

export interface OcrPdfPageOptions {
  dpi?: number;
  psm?: string;
}

/** OCRs a single page of a PDF whose bytes are already materialized on
 *  disk (see `materializePdf`). */
export async function ocrPdfPageFromWorkspace(
  pdfPath: string,
  dir: string,
  pageNumber: number,
  options: OcrPdfPageOptions = {},
): Promise<string> {
  const dpi = options.dpi ?? DEFAULT_DPI;
  const psm = options.psm ?? DEFAULT_PSM;
  const pngPath = await renderPdfPageToPng(pdfPath, dir, pageNumber, dpi);
  return ocrImageFile(pngPath, psm);
}

/** OCRs every page of a PDF given as raw bytes — convenience wrapper that
 *  owns its own scratch workspace end to end. Prefer
 *  `ocrPdfPageFromWorkspace` when the caller already has a workspace open
 *  (e.g. because it also needs `pdftotext` on the same file) to avoid
 *  materializing the PDF twice. */
export async function ocrPdfBytes(bytes: Buffer, pageNumbers: readonly number[], options: OcrPdfPageOptions = {}): Promise<Map<number, string>> {
  const ws = await materializePdf(bytes);
  try {
    const out = new Map<number, string>();
    for (const p of pageNumbers) {
      out.set(p, await ocrPdfPageFromWorkspace(ws.pdfPath, ws.dir, p, options));
    }
    return out;
  } finally {
    await ws.cleanup();
  }
}

export interface OcrImageOptions {
  psm?: string;
}

/** OCRs a standalone image (JPEG/PNG/TIFF/WEBP) given as raw bytes. */
export async function ocrImageBytes(bytes: Buffer, extension: string, options: OcrImageOptions = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'opsdash-extract-img-'));
  try {
    const imagePath = path.join(dir, `input.${extension}`);
    await writeFile(imagePath, bytes);
    return await ocrImageFile(imagePath, options.psm ?? DEFAULT_PSM);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
