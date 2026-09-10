/**
 * PDF text-layer extraction via `pdftotext` (poppler), plus the
 * text-density measurement that decides whether a page actually has a
 * usable text layer or needs OCR.
 *
 * "Decide 'has a text layer' by measuring, not by trusting the file"
 * (task brief) — a PDF can *claim* to have text (it isn't flagged as a pure
 * image) while carrying only a handful of stray characters per page, which
 * is exactly what a broken/partial text layer looks like. The fix here is
 * the same for both cases: render and OCR any page whose character count
 * falls under the threshold, page by page, rather than an all-or-nothing
 * decision for the whole document.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Below this many non-whitespace characters on a page, the text layer is
 *  treated as absent/unusable and the page is routed to OCR instead. */
export const MIN_CHARS_PER_PAGE = 40;

export class MissingToolError extends Error {
  constructor(tool: string) {
    super(
      `required system tool "${tool}" is not installed or not on PATH. ` +
        `PDF/image extraction depends on poppler (pdftotext, pdftoppm, pdfinfo) and tesseract; ` +
        `install them rather than silently returning empty text.`,
    );
    this.name = 'MissingToolError';
  }
}

async function runTool(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(cmd, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === 'ENOENT') throw new MissingToolError(cmd);
    throw new Error(`"${cmd} ${args.join(' ')}" failed: ${e.stderr ?? e.message}`);
  }
}

export interface PdfPageText {
  pageNumber: number;
  text: string;
  charCount: number;
}

export interface PdfTextLayerResult {
  pageCount: number;
  pages: PdfPageText[];
}

function countNonWhitespace(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n++;
  return n;
}

/** `pdfinfo`'s page count, the authoritative source — falls back to
 *  counting form-feed page breaks in `pdftotext` output if `pdfinfo` is
 *  unavailable for some reason other than it simply not being installed
 *  (in which case the missing-tool error should surface anyway, since both
 *  ship together in poppler). */
export async function getPdfPageCount(filePath: string): Promise<number> {
  const { stdout } = await runTool('pdfinfo', [filePath]);
  const m = /^Pages:\s*(\d+)/m.exec(stdout);
  if (!m || !m[1]) throw new Error(`pdfinfo did not report a page count for "${filePath}".`);
  return Number(m[1]);
}

/** Runs `pdftotext -layout` over the whole document and splits the output
 *  into per-page text on the form-feed (`\f`) page separator poppler
 *  emits. `-layout` preserves column alignment, which is what makes
 *  position-based table parsing (see `registration.ts`) possible at all. */
export async function extractPdfTextLayer(filePath: string, pageCount: number): Promise<PdfTextLayerResult> {
  const { stdout } = await runTool('pdftotext', ['-layout', filePath, '-']);
  const rawPages = stdout.split('\f');
  // poppler emits a trailing form-feed after the last page in some
  // versions, which produces a spurious empty trailing split element.
  const trimmedTrailing = rawPages.length > pageCount && (rawPages[rawPages.length - 1] ?? '').trim() === ''
    ? rawPages.slice(0, -1)
    : rawPages;

  const pages: PdfPageText[] = [];
  for (let i = 0; i < pageCount; i++) {
    const text = trimmedTrailing[i] ?? '';
    pages.push({ pageNumber: i + 1, text, charCount: countNonWhitespace(text) });
  }
  return { pageCount, pages };
}

export interface PdfWorkspace {
  dir: string;
  pdfPath: string;
  cleanup: () => Promise<void>;
}

/** Writes PDF bytes to a scratch temp directory so poppler/tesseract (both
 *  file-path tools, not stdin-capable for this purpose) have something to
 *  point at. Caller must call `cleanup()`. */
export async function materializePdf(bytes: Buffer): Promise<PdfWorkspace> {
  const dir = await mkdtemp(path.join(tmpdir(), 'opsdash-extract-'));
  const pdfPath = path.join(dir, 'input.pdf');
  await writeFile(pdfPath, bytes);
  return { dir, pdfPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export { runTool };
