/**
 * GET /api/health — for the platform's health check.
 *
 * Public, and touches neither the session nor the database: a health
 * check that needs either will report the app as dead during exactly the
 * incidents where you most want it to stay up and tell you what is wrong.
 */
import { NextResponse } from 'next/server';

export function GET(): Response {
  return NextResponse.json({ ok: true, at: new Date().toISOString() });
}
