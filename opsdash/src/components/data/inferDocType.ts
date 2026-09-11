import type { DocType } from '@/contract/types';

/**
 * Best-effort default for the upload screen's document-type selector, from
 * the file name alone. Never authoritative and never sent to the server on
 * its own — `POST /api/documents` requires an explicit `docType` because
 * the server cannot infer it from bytes, so this only pre-selects an option
 * the operator can still change before confirming the upload.
 */
export function inferDocType(fileName: string): DocType {
  const lower = fileName.toLowerCase();
  if (lower.includes('toll')) return 'toll';
  if (lower.includes('maint') || lower.includes('expense')) return 'maintenance';
  return 'fuel';
}

export const DOC_TYPE_OPTIONS: { value: DocType; label: string }[] = [
  { value: 'fuel', label: 'Fuel (EFS/Relay statement)' },
  { value: 'toll', label: 'Toll' },
  { value: 'maintenance', label: 'Maintenance / truck & trailer expenses' },
];
