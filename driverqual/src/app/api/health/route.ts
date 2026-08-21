import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Public liveness check for the hosting platform.
 *
 * It deliberately touches neither the database nor the session, so a health
 * check never depends on either — and so protecting the app does not make the
 * platform think it has died.
 */
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
