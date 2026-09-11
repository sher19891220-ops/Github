'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listDocuments } from './data/api';
import { errorMessageFor, isEmptyList, loaded, loading, errored, type FetchState } from './data/fetchState';
import type { DocumentSummary } from './data/types';
import { StatusPill } from './StatusPill';

const POLL_INTERVAL_MS = 3000;

function statusPill(doc: DocumentSummary) {
  if (doc.duplicateOf) return <StatusPill label="Duplicate" tone="warn" />;
  switch (doc.parseStatus) {
    case 'parsed':
      return <StatusPill label="Parsed" tone="good" />;
    case 'pending':
      return <StatusPill label="Parsing…" tone="warn" />;
    case 'failed':
      return <StatusPill label="Parse failed" tone="bad" />;
  }
}

/**
 * "What has been uploaded, parse status, row counts, and parse failures
 * shown plainly rather than as an empty table" — a failed parse renders as
 * its own row with the error text right there, never as a document that
 * quietly has zero rows and no explanation.
 *
 * Three states a real server (and an async, possibly minutes-long OCR
 * parse) produce that a mock never did:
 *
 *  - loading      — first fetch hasn't resolved. Its own message, not a
 *                    table that just happens to be empty.
 *  - unreachable  — the fetch failed. A dedicated banner with a retry
 *                    button, never silently rendered the same as "no
 *                    documents uploaded yet".
 *  - empty        — the fetch *succeeded* and there really are zero
 *                    documents. Only this one says "No documents uploaded
 *                    yet."
 *
 * While any listed document is still `parseStatus: 'pending'`, this polls
 * on an interval so a scanned document moving from "Parsing…" to "Parsed"
 * (or "Parse failed") shows up without the operator having to refresh.
 */
export function DocumentList({ refreshKey }: { refreshKey?: number }) {
  const [state, setState] = useState<FetchState<DocumentSummary[]>>(loading());
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listDocuments()
      .then((docs) => {
        if (!cancelled) setState(loaded(docs));
      })
      .catch((err) => {
        if (!cancelled) setState(errored(errorMessageFor(err, 'Could not load the document list.')));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, pollTick]);

  // Keep polling while anything is still being parsed, so "Parsing…" does
  // not sit there stale after the server has actually finished (or failed).
  useEffect(() => {
    if (state.status !== 'loaded') return;
    if (!state.data.some((d) => d.parseStatus === 'pending')) return;
    const timer = setTimeout(() => setPollTick((n) => n + 1), POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [state]);

  if (state.status === 'loading') {
    return <p style={{ color: 'var(--muted)' }}>Loading documents…</p>;
  }

  if (state.status === 'error') {
    return (
      <div role="alert" style={{ color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 8, padding: '0.75rem' }}>
        <p style={{ margin: 0, fontWeight: 600 }}>Could not load the document list</p>
        <p style={{ margin: '0.25rem 0 0' }}>
          {state.message} This does not mean there are no documents — the list simply has not loaded.
        </p>
        <button type="button" onClick={() => setPollTick((n) => n + 1)} style={{ marginTop: '0.5rem' }}>
          Retry
        </button>
      </div>
    );
  }

  if (isEmptyList(state)) {
    return <p style={{ color: 'var(--muted)' }}>No documents uploaded yet.</p>;
  }

  const documents = state.data;

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '2px solid var(--line)' }}>
          <th style={th}>File</th>
          <th style={th}>Type</th>
          <th style={th}>Status</th>
          <th style={{ ...th, textAlign: 'right' }}>Rows</th>
          <th style={th}>Uploaded</th>
          <th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {documents.map((doc) => (
          <tr key={doc.documentId} style={{ borderBottom: '1px solid var(--line)' }}>
            <td style={td}>{doc.fileName}</td>
            <td style={td}>{doc.docType}</td>
            <td style={td}>
              {statusPill(doc)}
              {doc.parseStatus === 'failed' && doc.parseError && (
                <div style={{ color: 'var(--bad)', fontSize: '0.85em', marginTop: '0.25rem', maxWidth: 480 }}>
                  {doc.parseError}
                </div>
              )}
              {doc.duplicateOf && (
                <div style={{ color: 'var(--muted)', fontSize: '0.85em', marginTop: '0.25rem' }}>
                  Same content as document {doc.duplicateOf} — not re-ingested.
                </div>
              )}
            </td>
            <td className="num" style={td}>{doc.rowCount}</td>
            <td style={td}>{new Date(doc.uploadedAt).toLocaleString()}</td>
            <td style={td}>
              {doc.parseStatus === 'parsed' && (
                <Link href={`/review/${doc.documentId}`} style={{ color: 'var(--accent)' }}>
                  Review →
                </Link>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '0.5rem', color: 'var(--muted)', fontWeight: 600 };
const td: React.CSSProperties = { padding: '0.5rem', verticalAlign: 'top' };
