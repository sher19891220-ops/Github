import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { extractDocuments } from '@/server/extraction';
import { UPLOAD_POLICY, validateUpload } from '@/server/settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: 'Expected a multipart form upload.' }, { status: 400 });
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'Attach at least one document.' }, { status: 400 });
  }
  if (files.length > UPLOAD_POLICY.maxFilesPerApplicant) {
    return NextResponse.json(
      { error: `Attach at most ${UPLOAD_POLICY.maxFilesPerApplicant} documents at a time.` },
      { status: 400 },
    );
  }

  // Server-side validation runs regardless of what the browser allowed through.
  const errors = files.flatMap(
    (f) => validateUpload({ name: f.name, type: f.type, size: f.size }).errors,
  );
  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(' '), errors }, { status: 400 });
  }

  const encoded = await Promise.all(
    files.map(async (f) => ({
      name: f.name,
      mimeType: f.type || 'application/octet-stream',
      base64: Buffer.from(await f.arrayBuffer()).toString('base64'),
    })),
  );

  const result = await extractDocuments(getDb(), encoded);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
