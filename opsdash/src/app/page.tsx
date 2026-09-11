import Link from 'next/link';
import { AccountingDashboard } from '@/components/dashboard/AccountingDashboard';

export default function Home() {
  return (
    <main style={{ padding: '2rem', maxWidth: 1100 }}>
      <AccountingDashboard />
      <nav style={{ marginTop: '2.5rem', borderTop: '1px solid var(--line)', paddingTop: '1rem' }}>
        <p style={{ color: 'var(--muted)', margin: '0 0 0.5rem' }}>All screens</p>
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
          <li>
            <Link href="/reconciliation" style={{ color: 'var(--accent)' }}>Reconciliation</Link> — sample data, no live endpoint yet
          </li>
          <li>
            <Link href="/chargeback" style={{ color: 'var(--accent)' }}>Chargeback</Link> — sample data, no live endpoint yet
          </li>
        </ul>
      </nav>
    </main>
  );
}
