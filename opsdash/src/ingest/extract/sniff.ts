/**
 * Content sniffing — decides what a dropped file actually is from its
 * bytes, never from the file extension or the declared MIME type (both
 * lie: a renamed file, a browser that sends `application/octet-stream` for
 * everything, a `.xlsx` that is actually a `.csv` someone renamed).
 */

export type SniffedKind = 'pdf' | 'xlsx' | 'image' | 'text' | 'unsupported';
export type ImageFormat = 'png' | 'jpeg' | 'tiff' | 'webp';

export interface SniffResult {
  kind: SniffedKind;
  imageFormat: ImageFormat | null;
  /** Human-readable reason, populated when `kind === 'unsupported'`. */
  reason: string | null;
}

function startsWith(bytes: Buffer, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

const PDF_SIG = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIG = [0xff, 0xd8, 0xff];
const TIFF_LE_SIG = [0x49, 0x49, 0x2a, 0x00];
const TIFF_BE_SIG = [0x4d, 0x4d, 0x00, 0x2a];
const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_SIG = [0x50, 0x4b, 0x05, 0x06];

function isWebp(bytes: Buffer): boolean {
  return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
}

/** Looks like plain text: mostly printable/whitespace bytes, no NUL, no
 *  binary control noise. Not a guarantee, just a bar binary content fails. */
export function looksLikeText(bytes: Buffer, sampleSize = 4096): boolean {
  if (bytes.length === 0) return true;
  const sample = bytes.subarray(0, Math.min(sampleSize, bytes.length));
  let controlCount = 0;
  for (const b of sample) {
    if (b === 0) return false; // NUL never appears in real text content
    const isPrintableAscii = b >= 0x20 && b <= 0x7e;
    const isCommonWhitespace = b === 0x09 || b === 0x0a || b === 0x0d;
    const isUtf8Continuation = b >= 0x80; // permissive: allow non-ASCII/UTF-8
    if (!isPrintableAscii && !isCommonWhitespace && !isUtf8Continuation) controlCount++;
  }
  return controlCount / sample.length < 0.01;
}

export function sniffBytes(bytes: Buffer, fileName: string): SniffResult {
  if (bytes.length === 0) {
    return { kind: 'unsupported', imageFormat: null, reason: 'file is empty (0 bytes).' };
  }

  if (startsWith(bytes, PDF_SIG)) return { kind: 'pdf', imageFormat: null, reason: null };
  if (startsWith(bytes, PNG_SIG)) return { kind: 'image', imageFormat: 'png', reason: null };
  if (startsWith(bytes, JPEG_SIG)) return { kind: 'image', imageFormat: 'jpeg', reason: null };
  if (startsWith(bytes, TIFF_LE_SIG) || startsWith(bytes, TIFF_BE_SIG)) {
    return { kind: 'image', imageFormat: 'tiff', reason: null };
  }
  if (isWebp(bytes)) return { kind: 'image', imageFormat: 'webp', reason: null };

  if (startsWith(bytes, ZIP_SIG) || startsWith(bytes, ZIP_EMPTY_SIG)) {
    // A zip container. XLSX/XLSM are zip containers, but so is any other
    // zip — the byte signature alone can't tell them apart. The extension
    // is used here only as a weak tiebreaker to decide *which* zip-based
    // parser to try; extractXlsx() itself is the real check (exceljs will
    // refuse anything that isn't a real workbook), so a mis-signalled file
    // still fails loudly rather than mis-parsing.
    if (/\.(xlsx|xlsm)$/i.test(fileName)) return { kind: 'xlsx', imageFormat: null, reason: null };
    return { kind: 'xlsx', imageFormat: null, reason: null };
  }

  if (looksLikeText(bytes)) return { kind: 'text', imageFormat: null, reason: null };

  return {
    kind: 'unsupported',
    imageFormat: null,
    reason: 'bytes do not match a known PDF, XLSX, image or text signature.',
  };
}
