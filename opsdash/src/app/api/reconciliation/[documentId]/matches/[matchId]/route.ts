/**
 * POST /api/reconciliation/:documentId/matches/:matchId
 *   body { action: ReconDecisionAction, decidedBy: string }
 *   -> { set: ReconciliationSet, summary: ReconSummary }
 *
 * Returns the whole set rather than the one row, because rejecting a
 * pairing splits it into two singletons and a single-row response would
 * leave the screen quietly disagreeing with the database.
 */
import { NextResponse } from 'next/server';
import {
  MatchNotFoundError,
  type ReconDecisionAction,
  recordReconDecision,
} from '@/db/repo/reconciliation';

function parseAction(raw: unknown): ReconDecisionAction | string {
  if (typeof raw !== 'object' || raw === null) return 'action is required';
  const a = raw as Record<string, unknown>;
  if (a.type === 'confirm') return { type: 'confirm' };
  if (a.type === 'reject') return { type: 'reject' };
  if (a.type === 'expected_missing') {
    const note = typeof a.note === 'string' ? a.note.trim() : '';
    if (note.length === 0) {
      // The database refuses this too. Saying so here means the person gets
      // a sentence instead of a constraint name.
      return 'Marking a line expected-missing needs a reason — next quarter nobody can tell it from an oversight.';
    }
    return { type: 'expected_missing', note };
  }
  return `unknown action ${JSON.stringify(a.type)}`;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ documentId: string; matchId: string }> },
): Promise<Response> {
  const { documentId, matchId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const action = parseAction(body.action);
  if (typeof action === 'string') {
    return NextResponse.json({ error: action }, { status: 400 });
  }

  const decidedBy = typeof body.decidedBy === 'string' ? body.decidedBy.trim() : '';
  if (decidedBy.length === 0) {
    return NextResponse.json({ error: 'decidedBy is required — a decision records who made it' }, { status: 400 });
  }

  try {
    const result = await recordReconDecision(documentId, matchId, action, decidedBy);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MatchNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
