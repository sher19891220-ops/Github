'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listDocuments } from './data/api';
import type { DocumentSummary } from './data/types';
import { StatusPill } from './StatusPill';

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
 */
export function DocumentList({ refreshKey }: { refreshKey?: number }) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listDocuments().then((docs) => {
      if (!cancelled) setDocuments(docs);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (documents === null) {
    return <p style={{ color: 'var(--muted)' }}>Loading documents…</p>;
  }

  if (documents.length === 0) {
    return <p style={{ color: 'var(--muted)' }}>No documents uploaded yet.</p>;
  }

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
