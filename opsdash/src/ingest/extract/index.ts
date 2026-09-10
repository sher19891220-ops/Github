/**
 * `extractDocument` — the one entry point this whole directory exists to
 * provide. Routes on sniffed content, never on file extension or declared
 * MIME type (see `sniff.ts`), and never fabricates a parse: an unsupported
 * input comes back `status: 'failed'` with a specific reason.
 *
 * What comes out of here is text/rows, not `StagingRow`s — see types.ts's
 * header comment. The output exists to fill the review queue
 * (SOURCE-DISCOVERY.md §14: OCR output never reaches the ledger directly),
 * not to post anything.
 */
import { extractPdfTextLayer, getPdfPageCount, materializePdf, MIN_CHARS_PER_PAGE } from './pdf';
import { ocrImageBytes, ocrPdfPageFromWorkspace, MissingToolError } from './ocr';
import { extractXlsx } from './xlsx';
import { decodeText, sniffDelimiter } from './csv';
import { sniffBytes, type ImageFormat } from './sniff';
import { failedExtraction, type DocKind, type ExtractedPage, type ExtractionResult } from './types';

export { MissingToolError } from './ocr';
export * from './types';
export * from './vin';
export * from './money';
export * from './validators';
export * from './registration';
export { sniffBytes, looksLikeText } from './sniff';
export { parseDelimited, sniffDelimiter, decodeText } from './csv';

function imageExtension(format: ImageFormat): string {
  return format === 'jpeg' ? 'jpg' : format;
}

async function extractPdf(bytes: Buffer): Promise<ExtractionResult> {
  const ws = await materializePdf(bytes);
  try {
    let pageCount: number;
    try {
      pageCount = await getPdfPageCount(ws.pdfPath);
    } catch (err) {
      if (err instanceof MissingToolError) throw err;
      return failedExtraction('unsupported', `could not read PDF page count: ${(err as Error).message}`);
    }
    if (pageCount < 1) {
      return failedExtraction('unsupported', 'PDF reports zero pages.');
    }

    const textLayer = await extractPdfTextLayer(ws.pdfPath, pageCount);

    const pages: ExtractedPage[] = [];
    let ocrdCount = 0;
    let textLayerCount = 0;

    for (const page of textLayer.pages) {
      if (page.charCount >= MIN_CHARS_PER_PAGE) {
        pages.push({ pageNumber: page.pageNumber, text: page.text, source: 'text_layer', charCount: page.charCount });
        textLayerCount++;
        continue;
      }
      // This page's text layer is absent or too sparse to trust — measured,
      // not assumed (task brief: "decide 'has a text layer' by measuring").
      // OCR just this page rather than discarding the whole document's real
      // text layer alongside it.
      const ocrText = await ocrPdfPageFromWorkspace(ws.pdfPath, ws.dir, page.pageNumber);
      const nonWs = ocrText.replace(/\s/g, '').length;
      pages.push({ pageNumber: page.pageNumber, text: ocrText, source: 'ocr', charCount: nonWs });
      ocrdCount++;
    }

    let kind: DocKind;
    if (ocrdCount === 0) kind = 'pdf_text';
    else if (textLayerCount === 0) kind = 'pdf_scanned';
    else kind = 'pdf_mixed';

    return { status: 'ok', error: null, kind, pages, sheets: null, delimiter: null, anyPageOcrd: ocrdCount > 0 };
  } finally {
    await ws.cleanup();
  }
}

async function extractImage(bytes: Buffer, format: ImageFormat): Promise<ExtractionResult> {
  const text = await ocrImageBytes(bytes, imageExtension(format));
  const charCount = text.replace(/\s/g, '').length;
  const page: ExtractedPage = { pageNumber: 1, text, source: 'ocr', charCount };
  return { status: 'ok', error: null, kind: 'image', pages: [page], sheets: null, delimiter: null, anyPageOcrd: true };
}

async function extractSpreadsheet(bytes: Buffer): Promise<ExtractionResult> {
  const result = await extractXlsx(bytes);
  if (result.status === 'failed') return failedExtraction('unsupported', result.error ?? 'failed to read workbook.');
  return { status: 'ok', error: null, kind: 'xlsx', pages: null, sheets: result.sheets, delimiter: null, anyPageOcrd: false };
}

function extractDelimited(bytes: Buffer): ExtractionResult {
  const text = decodeText(bytes);
  const delimiter = sniffDelimiter(text);
  const page: ExtractedPage = { pageNumber: 1, text, source: 'text_layer', charCount: text.replace(/\s/g, '').length };
  return { status: 'ok', error: null, kind: 'csv', pages: [page], sheets: null, delimiter, anyPageOcrd: false };
}

/**
 * Routes bytes to the right extractor by sniffing content, then runs it.
 *
 * `fileName`/`mimeType` are accepted for logging/diagnostics and as a weak
 * tiebreaker inside the sniffer (e.g. distinguishing an XLSX zip from some
 * other zip when the byte signature alone is ambiguous) — the routing
 * decision itself is made from the bytes.
 */
export async function extractDocument(bytes: Buffer, fileName: string, _mimeType: string): Promise<ExtractionResult> {
  const sniffed = sniffBytes(bytes, fileName);

  switch (sniffed.kind) {
    case 'pdf':
      return extractPdf(bytes);
    case 'image':
      if (!sniffed.imageFormat) return failedExtraction('unsupported', 'image signature matched but format could not be determined.');
      return extractImage(bytes, sniffed.imageFormat);
    case 'xlsx':
      return extractSpreadsheet(bytes);
    case 'text':
      // Text-looking bytes are read as text regardless of extension —
      // content wins over extension, exactly as the task brief requires.
      return extractDelimited(bytes);
    case 'unsupported':
    default:
      return failedExtraction('unsupported', sniffed.reason ?? `unrecognized content in "${fileName}".`);
  }
}
