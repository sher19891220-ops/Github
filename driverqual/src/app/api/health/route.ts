import { NextResponse } from 'next/server';
import { ENGINE_VERSION } from '@/domain/engine';
import { CURRENT_EXTRACTION_FORMAT_VERSION } from '@/domain/types';

export const dynamic = 'force-dynamic';

/**
 * Public liveness check for the hosting platform.
 *
 * It deliberately touches neither the database nor the session, so a health
 * check never depends on either — and so protecting the app does not make the
 * platform think it has died.
 *
 * The versions are here so "did my deploy actually go live?" is answerable
 * without signing in. Both are already stamped on every stored evaluation, so
 * neither reveals anything a reader could not otherwise obtain.
 */
export function GET() {
  return NextResponse.json({
    status: 'ok',
    engineVersion: ENGINE_VERSION,
    extractionFormatVersion: CURRENT_EXTRACTION_FORMAT_VERSION,
  });
}
