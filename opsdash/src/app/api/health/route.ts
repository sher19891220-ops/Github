/**
 * GET /api/health — for the platform's health check.
 *
 * Public, and touches neither the session nor the database: a health check
 * that needs either will report the app as dead during exactly the
 * incidents where you most want it to stay up and tell you what is wrong.
 *
 * It DOES check that document storage is configured, and returns 503 when
 * it is not. That is deliberate and it is the cheapest safety property in
 * this build: a deploy that forgot `BLOB_S3_BUCKET` fails its health check
 * and gets rolled back, instead of coming up healthy and writing every
 * upload into a directory the next deploy deletes. The failure that used to
 * be silent and permanent is now loud and immediate.
 *
 * Checking configuration, not connectivity — no round trip to the object
 * store on every ping. `?deep=1` does the round trip, for a human asking
 * "can this instance actually read and write documents right now".
 */
import { NextResponse } from 'next/server';
import { BlobStoreNotConfiguredError, describeBlobStore, hasBlob } from '@/db/repo/blobStore';

export async function GET(request: Request): Promise<Response> {
  const at = new Date().toISOString();

  let store: { kind: string; describe: string };
  try {
    store = await describeBlobStore();
  } catch (err) {
    if (err instanceof BlobStoreNotConfiguredError) {
      return NextResponse.json({ ok: false, at, error: err.message }, { status: 503 });
    }
    throw err;
  }

  const body: Record<string, unknown> = { ok: true, at, blobStore: store.kind };

  // Local storage outside production is normal. Local storage IN production
  // only happens when somebody set the override, and they should be
  // reminded of it every time they look.
  if (store.kind === 'local' && process.env.NODE_ENV === 'production') {
    body.warning =
      'Documents are being written to local disk in production. They will be lost on the next deploy.';
  }

  if (new URL(request.url).searchParams.get('deep') === '1') {
    try {
      // A key that cannot exist: this asks "can I talk to the store" without
      // reading anyone's document.
      await hasBlob(`${'0'.repeat(64)}.bin`);
      body.blobStoreReachable = true;
      body.blobStoreLocation = store.describe;
    } catch (err) {
      return NextResponse.json(
        { ok: false, at, blobStore: store.kind, blobStoreReachable: false, error: (err as Error).message },
        { status: 503 },
      );
    }
  }

  return NextResponse.json(body);
}
