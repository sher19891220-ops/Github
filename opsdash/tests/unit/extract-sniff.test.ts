import { describe, expect, it } from 'vitest';
import { sniffBytes } from '@/ingest/extract/sniff';
import { decodeText, parseDelimited, sniffDelimiter } from '@/ingest/extract/csv';

describe('sniffBytes — routes by content, never by extension', () => {
  it('recognizes a PDF by magic bytes even with the wrong extension', () => {
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('rest of file')]);
    const r = sniffBytes(bytes, 'invoice.xlsx'); // deliberately lying extension
    expect(r.kind).toBe('pdf');
  });

  it('recognizes a PNG by magic bytes regardless of extension', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
    const r = sniffBytes(png, 'scan.pdf'); // lying extension again
    expect(r.kind).toBe('image');
    expect(r.imageFormat).toBe('png');
  });

  it('recognizes a JPEG by magic bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0]);
    expect(sniffBytes(jpeg, 'x.bin').kind).toBe('image');
  });

  it('recognizes plain text content as text', () => {
    const bytes = Buffer.from('Unit,Driver,Amount\n1001,Jane Doe,2400.00\n');
    const r = sniffBytes(bytes, 'export.dat'); // extension gives no hint
    expect(r.kind).toBe('text');
  });

  it('rejects an empty file with a clear reason rather than guessing', () => {
    const r = sniffBytes(Buffer.alloc(0), 'empty.pdf');
    expect(r.kind).toBe('unsupported');
    expect(r.reason).toBeTruthy();
  });

  it('rejects unrecognizable binary content with a reason, never a fabricated kind', () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const r = sniffBytes(garbage, 'mystery');
    expect(r.kind).toBe('unsupported');
    expect(r.reason).toBeTruthy();
  });
});

describe('CSV/TSV decoding and delimiter sniffing', () => {
  it('sniffs comma as delimiter', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3\n4,5,6')).toBe(',');
  });

  it('sniffs tab as delimiter for a TSV', () => {
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('sniffs semicolon when it is the consistent delimiter', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
  });

  it('parses quoted fields containing the delimiter', () => {
    const rows = parseDelimited('Name,Note\n"Doe, Jane","says ""hi"""\n', ',');
    expect(rows[0]).toEqual(['Name', 'Note']);
    expect(rows[1]).toEqual(['Doe, Jane', 'says "hi"']);
  });

  it('strips a UTF-8 BOM before decoding', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\n1,2')]);
    const text = decodeText(withBom);
    expect(text.startsWith('a,b')).toBe(true);
  });
});
