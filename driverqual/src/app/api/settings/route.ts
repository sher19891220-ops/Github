import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { recordAudit } from '@/db/repo';
import {
  DEFAULT_EXTRACTION_MODEL,
  SETTING_KEYS,
  UPLOAD_POLICY,
  getExtractionModel,
  secretStatus,
  setSetting,
} from '@/server/settings';

export const dynamic = 'force-dynamic';

/** Returns status only. A stored secret never leaves the server in full. */
export async function GET() {
  const db = await getDb();
  return NextResponse.json({
    openai: await secretStatus(db, SETTING_KEYS.openaiApiKey),
    fmcsa: await secretStatus(db, SETTING_KEYS.fmcsaApiKey),
    extractionModel: await getExtractionModel(db),
    defaultModel: DEFAULT_EXTRACTION_MODEL,
    uploadPolicy: UPLOAD_POLICY,
  });
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);
  const db = await getDb();

  if (body?.key === undefined) {
    return NextResponse.json({ error: 'A setting key is required.' }, { status: 400 });
  }

  const allowed: string[] = Object.values(SETTING_KEYS);
  if (!allowed.includes(body.key)) {
    return NextResponse.json({ error: `Unknown setting "${body.key}".` }, { status: 400 });
  }

  const value = typeof body.value === 'string' ? body.value.trim() : null;

  if (body.key === SETTING_KEYS.openaiApiKey && value && !/^sk-[A-Za-z0-9_-]{10,}$/.test(value)) {
    return NextResponse.json(
      { error: 'That does not look like an OpenAI API key. Keys begin with "sk-".' },
      { status: 400 },
    );
  }

  await setSetting(db, body.key, value || null);
  await recordAudit(db, {
    actor: 'safety.admin',
    action: value ? 'setting.save' : 'setting.remove',
    entityType: 'setting',
    entityId: body.key,
    // The value itself is deliberately never written to the audit detail.
    detail: { key: body.key },
  });

  return NextResponse.json({
    ok: true,
    status:
      body.key === SETTING_KEYS.openaiModel
        ? { key: body.key, configured: Boolean(value) }
        : await secretStatus(db, body.key),
  });
}
