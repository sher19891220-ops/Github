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
      <ReviewTable documentId={documentId} />
    </div>
  );
}
