import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ padding: '2rem', maxWidth: 900 }}>
      <h1>Accounting</h1>
      <p style={{ color: 'var(--muted)' }}>Ingestion, review and reconciliation for the accounting team.</p>
      <ul>
        <li>
          <Link href="/documents" style={{ color: 'var(--accent)' }}>Documents</Link> — upload and parse status
        </li>
        <li>
          <Link href="/review" style={{ color: 'var(--accent)' }}>Review queue</Link> — correct and commit staging rows
        </li>
        <li>
          <Link href="/overhead" style={{ color: 'var(--accent)' }}>Per-truck overhead</Link> — registration cost rates
        </li>
      </ul>
    </main>
  );
}
