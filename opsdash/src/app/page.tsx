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
            <Link href="/pnl" style={{ color: 'var(--accent)' }}>P&amp;L</Link> — period-flexible, sliceable by company and truck
          </li>
          <li>
            <Link href="/ifta" style={{ color: 'var(--accent)' }}>IFTA</Link> — the return, the accrual, and the rate table
          </li>
          <li>
            <Link href="/fleet" style={{ color: 'var(--accent)' }}>Fleet status</Link> — where every truck is
          </li>
          <li>
            <Link href="/add" style={{ color: 'var(--accent)' }}>Add a figure</Link> — type one in, with an attestation
          </li>
          <li>
            <Link href="/sheets" style={{ color: 'var(--accent)' }}>Sheets</Link> — registered Google Sheet sources
          </li>
          <li>
            <Link href="/reconciliation" style={{ color: 'var(--accent)' }}>Reconciliation</Link> — match documents against the ledger
          </li>
          <li>
            <Link href="/chargeback" style={{ color: 'var(--accent)' }}>Chargeback</Link> — decide who bears each cost
          </li>
        </ul>
      </nav>
    </main>
  );
}
