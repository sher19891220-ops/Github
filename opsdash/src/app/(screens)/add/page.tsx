import { ManualEntryForm } from '@/components/ManualEntryForm';

export default function AddPage() {
  return (
    <div>
      <h1>Add a figure</h1>
      <p style={{ color: 'var(--muted)', maxWidth: '60ch' }}>
        For anything you know but do not have a document for yet. It goes on the books immediately, marked as
        your word rather than a parsed invoice — and when the document arrives, upload it and it supersedes
        this without erasing what you said.
      </p>
      <ManualEntryForm />
    </div>
  );
}
