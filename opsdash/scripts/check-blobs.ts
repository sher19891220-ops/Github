/**
 * Which documents have lost their original file?
 *
 * Needed because of a real failure, not a hypothetical one: documents used
 * to be written to a container's temp directory, so every deploy destroyed
 * them while leaving `source_document` rows behind pointing at keys that no
 * longer resolved. Those rows are not wrong — their ledger entries are
 * still valid and still traceable to a named file with a known checksum —
 * but the file itself has to come back from whoever sent it.
 *
 * This turns that from an unknown into a list somebody can work through.
 *
 *   npx tsx scripts/check-blobs.ts
 */
import { query } from '../src/db/pool';
import { hasBlob } from '../src/db/repo/blobStore';

interface Row {
  document_id: string;
  doc_type: string;
  file_name: string;
  storage_key: string;
  sha256: string;
  uploaded_at: string;
  entries: string;
}

async function main(): Promise<void> {
  const docs = await query<Row>(
    `SELECT sd.document_id, sd.doc_type, sd.file_name, sd.storage_key, sd.sha256,
            sd.uploaded_at::date::text AS uploaded_at,
            (SELECT count(*)::text FROM accounting.ledger_entry le
              WHERE le.source_document_id = sd.document_id) AS entries
       FROM accounting.source_document sd
      ORDER BY sd.uploaded_at`,
  );

  if (docs.length === 0) {
    console.log('No documents on file.');
    return;
  }

  const missing: Row[] = [];
  for (const d of docs) {
    if (!(await hasBlob(d.storage_key))) missing.push(d);
  }

  console.log(`${docs.length} document(s) on file, ${missing.length} with no stored copy.\n`);
  if (missing.length === 0) {
    console.log('Every document can be opened. Provenance is intact.');
    return;
  }

  console.log('These need re-uploading. Their ledger entries stay valid meanwhile —');
  console.log('the sha256 is what proves a re-upload is the same file:\n');
  for (const d of missing) {
    console.log(`  ${d.uploaded_at}  ${d.doc_type.padEnd(14)} ${d.file_name}`);
    console.log(`              ${d.entries} ledger entries, sha256 ${d.sha256.slice(0, 16)}...`);
  }
  console.log(
    '\nRe-uploading the identical file restores the copy without creating a second document:',
  );
  console.log('the sha256 already on record is what the upload path dedupes on.');
  process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
