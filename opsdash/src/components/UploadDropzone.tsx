'use client';

import { useEffect, useRef, useState } from 'react';
import type { DocType } from '@/contract/types';
import { getDocument, uploadDocument } from './data/api';
import { errorMessageFor } from './data/fetchState';
import { DOC_TYPE_OPTIONS, inferDocType } from './data/inferDocType';
import type { DocumentStatus } from './data/types';
import { StatusPill } from './StatusPill';

const ACCEPTED_EXTENSIONS = ['.pdf', '.xlsx', '.csv'];
const ACCEPTED_ATTR = ACCEPTED_EXTENSIONS.join(',');

// Fast poll for the common case (a text/CSV document that parses in well
// under a second), backing off once it looks like this one is going to take
// a while — a scanned PDF routed through OCR can take minutes, and hammering
// the server every 400ms for the whole time would be its own problem.
const FAST_POLL_MS = 500;
const FAST_POLL_ATTEMPTS = 10; // ~5s
const SLOW_POLL_MS = 5000;
const MAX_POLL_ATTEMPTS = 70; // ~5s fast + ~5.5min slow before auto-poll gives up

function isAccepted(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

type UploadState =
  | { phase: 'idle' }
  | { phase: 'selecting'; file: File; docType: DocType }
  | { phase: 'uploading'; fileName: string }
  | { phase: 'duplicate'; fileName: string; duplicateOf: string }
  | { phase: 'rejected'; fileName: string; reason: string }
  | { phase: 'upload-error'; fileName: string; message: string }
  /** Upload succeeded; parsing may still be in progress (it is async now —
   *  OCR on a scanned document can take minutes). `status` is always the
   *  most recently confirmed truth from the server, never assumed. */
  | { phase: 'tracking'; fileName: string; documentId: string; status: DocumentStatus | null; polling: boolean; attempts: number };

/**
 * Drag-drop (and click-to-browse) upload for PDF/XLSX/CSV. No manual
 * reformatting is asked of the operator — the file goes up as-is and the
 * parser does the work server-side. This component's job stops at: accept
 * the right file types, show that something is happening, and — this is
 * the part an empty table gets wrong — say plainly when the parse failed
 * (or an upload never reached the server at all) and why, instead of
 * silently rendering a table with nothing in it.
 *
 * Parsing is asynchronous: a fresh upload's `parseStatus` may sit at
 * `'pending'` for anywhere from under a second to several minutes. This
 * component polls honestly (with backoff) and, if parsing is still not
 * done when it stops actively polling, says so explicitly rather than
 * pretending the upload is "finished" — the documents list below keeps
 * polling independently, so the true status is never more than a few
 * seconds stale even after this component gives up hammering the server.
 */
export function UploadDropzone({ onUploaded }: { onUploaded?: (status: DocumentStatus) => void }) {
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File) {
    if (!isAccepted(file.name)) {
      setState({
        phase: 'rejected',
        fileName: file.name,
        reason: `"${file.name}" is not a PDF, XLSX or CSV. Only those three types are accepted.`,
      });
      return;
    }
    setState({ phase: 'selecting', file, docType: inferDocType(file.name) });
  }

  async function confirmUpload() {
    if (state.phase !== 'selecting') return;
    const { file, docType } = state;
    setState({ phase: 'uploading', fileName: file.name });
    try {
      const result = await uploadDocument({ file, docType });
      if (result.duplicateOf) {
        setState({ phase: 'duplicate', fileName: file.name, duplicateOf: result.duplicateOf });
        return;
      }
      const status = await getDocument(result.documentId);
      setState({ phase: 'tracking', fileName: file.name, documentId: result.documentId, status, polling: true, attempts: 0 });
      if (status) onUploaded?.(status);
    } catch (err) {
      setState({ phase: 'upload-error', fileName: file.name, message: errorMessageFor(err, 'The upload did not reach the server.') });
    }
  }

  // Poll while parsing is still pending, backing off, and stopping (without
  // ever claiming a false "done") past MAX_POLL_ATTEMPTS.
  useEffect(() => {
    if (state.phase !== 'tracking' || !state.polling) return;
    if (state.status?.parseStatus !== 'pending') return;
    if (state.attempts >= MAX_POLL_ATTEMPTS) {
      setState((prev) => (prev.phase === 'tracking' ? { ...prev, polling: false } : prev));
      return;
    }
    const delayMs = state.attempts < FAST_POLL_ATTEMPTS ? FAST_POLL_MS : SLOW_POLL_MS;
    const timer = setTimeout(() => {
      getDocument(state.documentId).then((status) => {
        setState((prev) =>
          prev.phase === 'tracking' && prev.documentId === state.documentId
            ? { ...prev, status, attempts: prev.attempts + 1 }
            : prev,
        );
        if (status && status.parseStatus !== 'pending') onUploaded?.(status);
      });
    }, delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase === 'tracking' ? state.attempts : -1, state.phase === 'tracking' ? state.polling : false]);

  function checkNow() {
    if (state.phase !== 'tracking') return;
    getDocument(state.documentId).then((status) => {
      setState((prev) => (prev.phase === 'tracking' ? { ...prev, status, polling: true, attempts: 0 } : prev));
      if (status && status.parseStatus !== 'pending') onUploaded?.(status);
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
          if (file) handleFile(file);
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
            if (file) handleFile(file);
          }}
        />
        <p style={{ margin: 0, fontWeight: 600 }}>Drop a PDF, XLSX or CSV here, or click to browse</p>
        <p style={{ margin: '0.25rem 0 0', color: 'var(--muted)', fontSize: '0.9em' }}>
          No reformatting needed — upload the file as it came from the bank, EFS/Relay, or the shop.
        </p>
      </div>

      {state.phase === 'selecting' && (
        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span>&quot;{state.file.name}&quot;</span>
          <label style={{ color: 'var(--muted)', fontSize: '0.9em' }}>
            Document type{' '}
            <select
              value={state.docType}
              onChange={(e) => setState({ ...state, docType: e.target.value as DocType })}
              style={{ marginLeft: '0.3rem' }}
            >
              {DOC_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={confirmUpload}>
            Upload
          </button>
          <button type="button" onClick={reset}>
            Cancel
          </button>
        </div>
      )}

      {state.phase === 'uploading' && (
        <p style={{ color: 'var(--muted)' }}>Uploading {state.fileName}…</p>
      )}

      {state.phase === 'upload-error' && (
        <div role="alert" style={{ color: 'var(--bad)', marginTop: '0.5rem' }}>
          <StatusPill label="Upload failed" tone="bad" />
          <p style={{ margin: '0.35rem 0 0' }}>
            &quot;{state.fileName}&quot; was not uploaded: {state.message} Nothing was saved — it is safe to try again.
          </p>
          <button type="button" onClick={reset} style={{ marginTop: '0.35rem' }}>
            Try again
          </button>
        </div>
      )}

      {state.phase === 'duplicate' && (
        <div role="status" style={{ color: 'var(--warn)', marginTop: '0.5rem' }}>
          <StatusPill label="Duplicate" tone="warn" /> &quot;{state.fileName}&quot; is byte-identical to a
          document already on file (document {state.duplicateOf}). It was reported, not re-ingested —
          no rows were added twice.
          <button type="button" onClick={reset} style={{ marginLeft: '0.75rem' }}>
            Upload another
          </button>
        </div>
      )}
      {state.phase === 'rejected' && (
        <div role="alert" style={{ color: 'var(--bad)', marginTop: '0.5rem' }}>
          <StatusPill label="Rejected" tone="bad" /> {state.reason}
          <button type="button" onClick={reset} style={{ marginLeft: '0.75rem' }}>
            Try again
          </button>
        </div>
      )}

      {state.phase === 'tracking' && state.status === null && (
        <div role="alert" style={{ color: 'var(--bad)', marginTop: '0.5rem' }}>
          <StatusPill label="Unknown" tone="bad" /> &quot;{state.fileName}&quot; uploaded (document{' '}
          {state.documentId}), but its status could not be confirmed just now.
          <button type="button" onClick={checkNow} style={{ marginLeft: '0.75rem' }}>
            Check again
          </button>
        </div>
      )}
      {state.phase === 'tracking' && state.status?.parseStatus === 'pending' && (
        <div role="status" style={{ marginTop: '0.5rem' }}>
          <StatusPill label="Parsing…" tone="warn" /> &quot;{state.fileName}&quot; is still being read
          {!state.polling && ' (this is taking a while — scanned documents can take several minutes)'}.
          {!state.polling && (
            <button type="button" onClick={checkNow} style={{ marginLeft: '0.75rem' }}>
              Check again
            </button>
          )}
          <div style={{ color: 'var(--muted)', fontSize: '0.85em', marginTop: '0.25rem' }}>
            It will also show up as &quot;Parsing…&quot; in the documents list below until it finishes.
          </div>
        </div>
      )}
      {state.phase === 'tracking' && state.status?.parseStatus === 'failed' && (
        <div role="alert" style={{ color: 'var(--bad)', marginTop: '0.5rem' }}>
          <StatusPill label="Parse failed" tone="bad" />
          <p style={{ margin: '0.35rem 0 0' }}>
            &quot;{state.fileName}&quot; could not be parsed: {state.status.parseError ?? 'unknown error'}
          </p>
          <button type="button" onClick={reset} style={{ marginTop: '0.35rem' }}>
            Upload another
          </button>
        </div>
      )}
      {state.phase === 'tracking' && state.status?.parseStatus === 'parsed' && (
        <div role="status" style={{ color: 'var(--good)', marginTop: '0.5rem' }}>
          <StatusPill label="Parsed" tone="good" /> &quot;{state.fileName}&quot; is ready for review
          ({state.status.rowCount} row{state.status.rowCount === 1 ? '' : 's'}).
          <button type="button" onClick={reset} style={{ marginLeft: '0.75rem' }}>
            Upload another
          </button>
        </div>
      )}
    </div>
  );
}
