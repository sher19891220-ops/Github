import { BulkCategorise } from '@/components/BulkCategorise';
import { ReviewTable } from '@/components/ReviewTable';

export default async function ReviewDocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  return (
    <div>
      <h1>Review — {documentId}</h1>
      {/* Above the table on purpose: on a real expenses export the table
          is 1,342 rows, and the groups turn that into nine decisions.
          Putting the per-row editor first would mean nobody finds this. */}
      <BulkCategorise documentId={documentId} />
      <ReviewTable documentId={documentId} />
    </div>
  );
}
