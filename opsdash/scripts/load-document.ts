/**
 * Loads one real source file into the ledger through the SAME path a human
 * upload takes: store bytes, parse, stage, then commit.
 *
 * This exists because it did not, and that was a hole in the foundation.
 * Revenue and the toll/maintenance sheet were originally posted with
 * throwaway commands that were never committed, which meant the ledger
 * behind the P&L could not be rebuilt from this repository — the numbers
 * were real but not reproducible. Everything else (the rate card, driver
 * pay, the trailer split) already had a committed script; this closes the
 * two that did not.
 *
 * It deliberately does NOT use a side door into `ledger_entry`. It calls
 * `createDocument` and `commitDocument`, so a scripted load is subject to
 * every rule an uploaded file is subject to: content-addressed dedupe,
 * entity resolution, the review hold, the required-field check and the
 * ownership-conflict check. If a scripted load and an upload of the same
 * bytes ever disagreed, one of them would be lying.
 *
 * Without `--apply` it stages and stops. That is not a dry run in the
 * pretend sense — the rows really are written to staging, which is the
 * review area and not the ledger. Committing is the gate, and the gate
 * needs the flag.
 *
 *   npx tsx scripts/load-document.ts <doc-type> <path> <uploaded-by> [--apply]
 *
 * doc-type is one the parser router knows: revenue, fuel, fuel_card,
 * toll, maintenance, ifta_mileage.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { query } from '../src/db/pool';
import { createDocument, getDocumentSummary } from '../src/db/repo/documents';
import { commitDocument, NonPostingDocumentError } from '../src/db/repo/commit';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const [docType, path, uploadedBy] = argv.filter((a) => !a.startsWith('--'));

  if (!docType || !path || !uploadedBy) {
    throw new Error('Usage: load-document.ts <doc-type> <path> <uploaded-by> [--apply]');
  }

  const bytes = readFileSync(path);
  const fileName = basename(path);

  const created = await createDocument({
    docType,
    fileName,
    mimeType: 'text/plain',
    bytes,
    uploadedBy,
  });

  if (created.duplicateOf) {
    console.log(`${fileName}: these exact bytes are already document ${created.duplicateOf}.`);
    console.log('Nothing re-parsed. Re-run with a changed file, or commit the existing document.');
  } else {
    console.log(`${fileName}: stored as ${created.documentId}`);
    console.log(`  sha256 ${created.sha256}`);
  }

  const documentId = created.duplicateOf ?? created.documentId;
  const summary = await getDocumentSummary(documentId);
  if (!summary) throw new Error(`document ${documentId} vanished after creation`);

  console.log(`  parse: ${summary.parseStatus}${summary.parseError ? ` — ${summary.parseError}` : ''}`);

  const staged = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM accounting.staging_row
      WHERE document_id = $1 GROUP BY status ORDER BY status`,
    [documentId],
  );
  if (staged.length === 0) {
    console.log('  staged: nothing');
  } else {
    console.log(`  staged: ${staged.map((r) => `${r.n} ${r.status}`).join(', ')}`);
  }

  if (!apply) {
    console.log('\nStaged only. Re-run with --apply to commit what is eligible.');
    return;
  }

  try {
    const result = await commitDocument(documentId, uploadedBy);
    console.log(`\n  committed ${result.committed}`);
    console.log(`  rejected  ${result.rejected}`);
    console.log(`  held      ${result.held}  (under review — a person must clear these)`);
  } catch (err) {
    if (err instanceof NonPostingDocumentError) {
      console.log(`\n  not posted: ${err.message}`);
      return;
    }
    throw err;
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
