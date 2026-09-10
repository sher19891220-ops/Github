/**
 * POST /api/documents — DATA-CONTRACT.md §6.
 *
 * multipart/form-data with fields:
 *   file        (required) the dropped PDF/XLSX/CSV/text
 *   docType     (required) one of the accounting.doc_type values
 *   uploadedBy  (optional) defaults to "unknown"
 *
 * Upload is content-addressed (sha256): dropping the same bytes twice
 * returns the existing document as `duplicateOf` instead of creating a
 * second one. Parsing (for text-decodable content) happens synchronously —
 * see src/db/repo/documents.ts.
 */
import { NextResponse } from 'next/server';
import { createDocument } from '@/db/repo/documents';

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'missing required "file" field' }, { status: 400 });
  }

  const docType = form.get('docType');
  if (typeof docType !== 'string' || docType.trim() === '') {
    return NextResponse.json({ error: 'missing required "docType" field' }, { status: 400 });
  }

  const uploadedByField = form.get('uploadedBy');
  const uploadedBy = typeof uploadedByField === 'string' && uploadedByField.trim() !== '' ? uploadedByField : 'unknown';

  const bytes = Buffer.from(await file.arrayBuffer());

  try {
    const result = await createDocument({
      docType,
      fileName: file.name || 'upload',
      mimeType: file.type || 'application/octet-stream',
      bytes,
      uploadedBy,
    });

    return NextResponse.json(
      {
        documentId: result.documentId,
        sha256: result.sha256,
        ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}),
      },
      { status: result.duplicateOf ? 200 : 201 },
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
