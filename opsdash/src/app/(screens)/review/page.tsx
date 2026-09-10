'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listDocuments } from '@/components/data/api';
import type { DocumentSummary } from '@/components/data/types';

/** The review queue is per document (a commit is one action per document);
 *  this index picks the parsed documents an operator still has to work and
 *  hands off to `/review/[documentId]` for the actual table. */
export default function ReviewIndexPage() {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);

  useEffect(() => {
    listDocuments().then(setDocuments);
  }, []);

  if (documents === null) return <p style={{ color: 'var(--muted)' }}>Loading…</p>;

  const reviewable = documents.filter((d) => d.parseStatus === 'parsed');

  if (reviewable.length === 0) {
    return <p style={{ color: 'var(--muted)' }}>No parsed documents are waiting on review.</p>;
  }

  return (
    <div>
      <h1>Review queue</h1>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {reviewable.map((doc) => (
          <li key={doc.documentId} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--line)' }}>
            <Link href={`/review/${doc.documentId}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {doc.fileName}
            </Link>
            <span style={{ color: 'var(--muted)', marginLeft: '0.75rem' }}>
              {doc.docType} · {doc.rowCount} row{doc.rowCount === 1 ? '' : 's'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
