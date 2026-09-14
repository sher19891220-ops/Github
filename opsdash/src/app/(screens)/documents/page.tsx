'use client';

import { useState } from 'react';
import { DocumentList } from '@/components/DocumentList';
import { UploadDropzone } from '@/components/UploadDropzone';

export default function DocumentsPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div>
      <h1>Documents</h1>
      <p style={{ color: 'var(--muted)' }}>
        Drop a PDF, XLSX or CSV to ingest it. A re-upload of a file already on file is reported as a
        duplicate rather than parsed again.
      </p>
      <UploadDropzone onUploaded={() => setRefreshKey((k) => k + 1)} />
      <h2 style={{ marginTop: '2rem' }}>Uploaded documents</h2>
      <DocumentList refreshKey={refreshKey} />
    </div>
  );
}
