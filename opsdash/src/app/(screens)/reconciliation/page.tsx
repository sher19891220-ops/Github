'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listDocuments } from '@/components/data/api';
import type { DocumentSummary } from '@/components/data/types';

/** Reconciliation is per document, the same shape as the review queue: one
 *  document (an EFS statement, a vendor invoice) checked against what is
 *  already recorded. This index picks the parsed document; the actual
 *  match view lives at `/reconciliation/[documentId]`. */
export default function ReconciliationIndexPage() {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);

  useEffect(() => {
    listDocuments().then(setDocuments);
  }, []);

  if (documents === null) return <p style={{ color: 'var(--muted)' }}>Loading…</p>;

  const reconcilable = documents.filter((d) => d.parseStatus === 'parsed');

  return (
    <div>
      <h1>Reconciliation</h1>
      <p style={{ color: 'var(--muted)' }}>
        Pick a document to check against what is already recorded. Unambiguous matches (same amount, date and
        unit) are handled automatically — only the variances and the unmatched lines need a person.
      </p>
      {reconcilable.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No parsed documents are available to reconcile.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {reconcilable.map((doc) => (
            <li key={doc.documentId} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--line)' }}>
              <Link href={`/reconciliation/${doc.documentId}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
                {doc.fileName}
              </Link>
              <span style={{ color: 'var(--muted)', marginLeft: '0.75rem' }}>
                {doc.docType} · {doc.rowCount} row{doc.rowCount === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
