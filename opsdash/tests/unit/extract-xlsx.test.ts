import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { extractDocument } from '@/ingest/extract';
import { extractXlsx } from '@/ingest/extract/xlsx';

/** Builds a small XLSX in memory with exceljs — the tool the task brief
 *  names for both writing and reading — and hands back its bytes. */
async function buildWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Fuel');
  ws.addRow(['Unit', 'Driver', 'Location', 'Gallon', 'Price']);
  ws.addRow(['1365', 'Jane Doe', '123 Main St, Belmont, OH 43718', 80.5, 3.56]);
  ws.addRow(['1431', 'John Roe', '9 Elm St, Toledo, OH 43604', 'full tank', '3.42$']);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe('XLSX round trip (exceljs -> extractXlsx)', () => {
  it('reads back the sheet name and header row exactly', async () => {
    const bytes = await buildWorkbook();
    const result = await extractXlsx(bytes);
    expect(result.status).toBe('ok');
    const sheet = result.sheets?.[0];
    expect(sheet?.name).toBe('Fuel');
    expect(sheet?.rows[0]).toEqual(['Unit', 'Driver', 'Location', 'Gallon', 'Price']);
  });

  it('reads back string cells exactly, byte for byte', async () => {
    const bytes = await buildWorkbook();
    const result = await extractXlsx(bytes);
    const rows = result.sheets![0]!.rows;
    expect(rows[2]).toEqual(['1431', 'John Roe', '9 Elm St, Toledo, OH 43604', 'full tank', '3.42$']);
  });

  it('reads back numeric cells at full precision (compared numerically, since XLSX numbers are IEEE754 doubles)', async () => {
    const bytes = await buildWorkbook();
    const result = await extractXlsx(bytes);
    const rows = result.sheets![0]!.rows;
    expect(Number(rows[1]![3])).toBe(80.5);
    expect(Number(rows[1]![4])).toBe(3.56);
    expect(typeof rows[1]![3]).toBe('string'); // never handed back as a JS number
  });

  it('routes through extractDocument end to end and is sniffed as xlsx from content, not extension', async () => {
    const bytes = await buildWorkbook();
    const result = await extractDocument(bytes, 'whatever-name.bin', 'application/octet-stream');
    expect(result.status).toBe('ok');
    expect(result.kind).toBe('xlsx');
    expect(result.sheets?.[0]?.rows.length).toBe(3);
  });

  it('fails loudly, never a fabricated parse, for a zip that is not a real workbook', async () => {
    // Zip local-file-header signature with garbage after it — passes the
    // byte-signature sniff but is not a workbook exceljs can open.
    const notAWorkbook = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const result = await extractXlsx(notAWorkbook);
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });
});
