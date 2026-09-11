/**
 * GET  /api/chargeback ?status&entityId&from&to&limit -> { rows: ChargebackRow[] }
 * POST /api/chargeback  body { costRowIds: string[], decision: ChargebackDecision }
 *                       -> { rows: ChargebackRow[] }
 *
 * The POST applies one decision to every named row and to no other row.
 * That guarantee is the whole reason the screen can offer bulk apply at
 * all: 713 undecided rows are only tractable in groups, and a bulk action
 * that might touch a row you did not select is worse than no bulk action.
 */
import { NextResponse } from 'next/server';
import type { ChargebackDecision } from '@/contract/types';
import {
  type ChargebackFilter,
  InvalidChargebackDecisionError,
  UnknownCostRowError,
  listChargebackRows,
  recordChargebackDecisions,
} from '@/db/repo/chargeback';

function parseStatus(raw: string | null): ChargebackFilter['status'] {
  if (raw === 'decided' || raw === 'all' || raw === 'open') return raw;
  return 'open';
}

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const limitRaw = p.get('limit');
  const limit = limitRaw !== null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined;

  try {
    const rows = await listChargebackRows({
      status: parseStatus(p.get('status')),
      entityId: p.get('entityId') ?? undefined,
      from: p.get('from') ?? undefined,
      to: p.get('to') ?? undefined,
      limit,
    });
    return NextResponse.json({ rows });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const ids = body.costRowIds;
  if (!Array.isArray(ids) || ids.some((v) => typeof v !== 'string')) {
    return NextResponse.json({ error: 'costRowIds must be an array of ids' }, { status: 400 });
  }
  if (typeof body.decision !== 'object' || body.decision === null) {
    return NextResponse.json({ error: 'decision is required' }, { status: 400 });
  }

  try {
    const rows = await recordChargebackDecisions(ids as string[], body.decision as ChargebackDecision);
    return NextResponse.json({ rows });
  } catch (err) {
    if (err instanceof InvalidChargebackDecisionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof UnknownCostRowError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
