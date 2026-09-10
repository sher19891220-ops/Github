'use client';

import { useRef, useState } from 'react';
import { uploadDocument, getDocument } from './data/api';
import type { DocumentSummary } from './data/types';
import { StatusPill } from './StatusPill';

const ACCEPTED_EXTENSIONS = ['.pdf', '.xlsx', '.csv'];
const ACCEPTED_ATTR = ACCEPTED_EXTENSIONS.join(',');

function isAccepted(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading'; fileName: string }
  | { phase: 'parsing'; fileName: string; documentId: string }
  | { phase: 'done'; fileName: string; summary: DocumentSummary }
  | { phase: 'duplicate'; fileName: string; duplicateOf: string }
  | { phase: 'rejected'; fileName: string; reason: string };

/**
 * Drag-drop (and click-to-browse) upload for PDF/XLSX/CSV. No manual
 * reformatting is asked of the operator — the file goes up as-is and the
 * parser does the work server-side. This component's job stops at: accept
 * the right file types, show that something is happening, and — this is
 * the part an empty table gets wrong — say plainly when the parse failed
 * and why, instead of silently rendering a table with nothing in it.
 */
export function UploadDropzone({ onUploaded }: { onUploaded?: (summary: DocumentSummary) => void }) {
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (!isAccepted(file.name)) {
      setState({
        phase: 'rejected',
        fileName: file.name,
        reason: `"${file.name}" is not a PDF, XLSX or CSV. Only those three types are accepted.`,
      });
      return;
    }

    setState({ phase: 'uploading', fileName: file.name });
    const result = await uploadDocument({ name: file.name, size: file.size, type: file.type });

    if (result.duplicateOf) {
      setState({ phase: 'duplicate', fileName: file.name, duplicateOf: result.duplicateOf });
      return;
    }

    setState({ phase: 'parsing', fileName: file.name, documentId: result.documentId });
    pollForParse(file.name, result.documentId);
  }

  function pollForParse(fileName: string, documentId: string, attempt = 0) {
    getDocument(documentId).then((summary) => {
      if (!summary) return;
      if (summary.parseStatus === 'pending' && attempt < 20) {
        setTimeout(() => pollForParse(fileName, documentId, attempt + 1), 400);
        return;
      }
      setState({ phase: 'done', fileName, summary });
      onUploaded?.(summary);
    });
  }

  function reset() {
    setState({ phase: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        style={{
          border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--line)'}`,
          borderRadius: 8,
          padding: '1.5rem',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragOver ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_ATTR}
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        <p style={{ margin: 0, fontWeight: 600 }}>Drop a PDF, XLSX or CSV here, or click to browse</p>
        <p style={{ margin: '0.25rem 0 0', color: 'var(--muted)', fontSize: '0.9em' }}>
          No reformatting needed — upload the file as it came from the bank, EFS/Relay, or the shop.
        </p>
      </div>

      {state.phase === 'uploading' && (
        <p style={{ color: 'var(--muted)' }}>Uploading {state.fileName}…</p>
      )}
      {state.phase === 'parsing' && (
        <p style={{ color: 'var(--muted)' }}>
          <StatusPill label="Parsing" tone="warn" /> {state.fileName}
        </p>
      )}
      {state.phase === 'duplicate' && (
        <div role="status" style={{ color: 'var(--warn)' }}>
          <StatusPill label="Duplicate" tone="warn" /> &quot;{state.fileName}&quot; is byte-identical to a
          document already on file (document {state.duplicateOf}). It was reported, not re-ingested —
          no rows were added twice.
          <button type="button" onClick={reset} style={{ marginLeft: '0.75rem' }}>
            Upload another
          </button>
        </div>
      )}
      {state.phase === 'rejected' && (
        <div role="alert" style={{ color: 'var(--bad)' }}>
          <StatusPill label="Rejected" tone="bad" /> {state.reason}
          <button type="button" onClick={reset} style={{ marginLeft: '0.75rem' }}>
            Try again
          </button>
        </div>
      )}
      {state.phase === 'done' && state.summary.parseStatus === 'failed' && (
        <div role="alert" style={{ color: 'var(--bad)', marginTop: '0.5rem' }}>
          <StatusPill label="Parse failed" tone="bad" />
          <p style={{ margin: '0.35rem 0 0' }}>
            &quot;{state.fileName}&quot; could not be parsed: {state.summary.parseError ?? 'unknown error'}
          </p>
          <button type="button" onClick={reset} style={{ marginTop: '0.35rem' }}>
            Upload another
          </button>
        </div>
      )}
      {state.phase === 'done' && state.summary.parseStatus === 'parsed' && (
        <div role="status" style={{ color: 'var(--good)', marginTop: '0.5rem' }}>
          <StatusPill label="Parsed" tone="good" /> &quot;{state.fileName}&quot; is ready for review
          ({state.summary.rowCount} row{state.summary.rowCount === 1 ? '' : 's'}).
          <button type="button" onClick={reset} style={{ marginLeft: '0.75rem' }}>
            Upload another
          </button>
        </div>
      )}
    </div>
  );
}
