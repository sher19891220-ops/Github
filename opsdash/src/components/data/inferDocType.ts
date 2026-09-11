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
  if (lower.includes('ifta') || lower.includes('mileage')) return 'ifta_mileage';
  // A vendor name in the filename is a strong signal it is the card's own
  // statement rather than the hand-kept fuel log.
  if (/efs|relay|wex|comdata|statement|invoice/.test(lower)) return 'fuel_card';
  return 'fuel';
}

/** The label on the first option used to read "Fuel (EFS/Relay
 *  statement)" while routing to the *sheet* parser — a promise the
 *  routing did not keep. The two are now separate options because they
 *  are separate documents: the sheet knows where fuel was bought, the
 *  statement knows how much. */
export const DOC_TYPE_OPTIONS: { value: DocType; label: string }[] = [
  { value: 'fuel_card', label: 'Fuel card statement (EFS / Relay / WEX / Comdata)' },
  { value: 'fuel', label: 'Fuel log sheet (the hand-kept purchase list)' },
  { value: 'ifta_mileage', label: 'IFTA mileage report (telematics export)' },
  { value: 'toll', label: 'Toll' },
  { value: 'maintenance', label: 'Maintenance / truck & trailer expenses' },
];
