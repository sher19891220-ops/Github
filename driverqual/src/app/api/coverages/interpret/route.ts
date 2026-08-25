import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { getProvider } from '@/server/provider';
import { UPLOAD_POLICY, validateUpload } from '@/server/settings';
import { normalizeCoverageType } from '@/domain/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Reads a certificate of insurance into correctable coverage rows. */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: 'Expected a multipart form upload.' }, { status: 400 });
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'Attach the certificate of insurance.' }, { status: 400 });
  }
  if (files.length > UPLOAD_POLICY.maxFilesPerApplicant) {
    return NextResponse.json({ error: 'Too many files attached.' }, { status: 400 });
  }

  const errors = files.flatMap(
    (f) => validateUpload({ name: f.name, type: f.type, size: f.size }).errors,
  );
  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(' '), errors }, { status: 400 });
  }

  const provider = await getProvider(await getDb());
  if (!provider) {
    return NextResponse.json(
      {
        error:
          'No document-intelligence provider is configured, so the certificate cannot be read automatically. Add a key under Settings → Integrations, or enter the coverage by hand.',
      },
      { status: 422 },
    );
  }

  const encoded = await Promise.all(
    files.map(async (f) => ({
      name: f.name,
      mimeType: f.type || 'application/octet-stream',
      base64: Buffer.from(await f.arrayBuffer()).toString('base64'),
    })),
  );

  const outcome = await provider.extractCertificateOfInsurance(encoded);
  if (!outcome.ok || !outcome.value) {
    return NextResponse.json(
      { error: outcome.errors.join(' '), errors: outcome.errors },
      { status: 422 },
    );
  }

  // Coverage names are normalised here rather than by the provider, so an
  // unrecognised label surfaces for correction instead of being guessed at.
  return NextResponse.json({
    ok: true,
    coverages: outcome.value.map((c) => ({
      ...c,
      normalizedCoverageType: c.coverageType ? normalizeCoverageType(c.coverageType) : null,
    })),
    warnings: outcome.warnings,
  });
}
