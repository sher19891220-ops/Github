import { ReconciliationView } from '@/components/ReconciliationView';

export default async function ReconciliationDocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  return (
    <div>
      <h1>Reconciliation — {documentId}</h1>
      <ReconciliationView documentId={documentId} />
    </div>
  );
}
