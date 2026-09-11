import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';

/**
 * `flexShrink: 0` is the load-bearing part. Without it a wrapping nav
 * squeezes each link below its text instead of moving it to the next line,
 * so at phone width "Review queue" breaks across two lines while
 * "Per-truck overhead" still runs off the right edge and scrolls the whole
 * page sideways.
 */
const navLink: CSSProperties = {
  color: 'var(--fg)',
  fontWeight: 600,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

export default function ScreensLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <nav
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem 1.25rem',
          padding: '0.75rem 1.5rem',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <Link href="/" style={navLink}>
          Dashboard
        </Link>
        <Link href="/documents" style={navLink}>
          Documents
        </Link>
        <Link href="/review" style={navLink}>
          Review queue
        </Link>
        <Link href="/add" style={navLink}>
          Add a figure
        </Link>
        <Link href="/sheets" style={navLink}>
          Sheets
        </Link>
        <Link href="/fleet" style={navLink}>
          Fleet status
        </Link>
        <Link href="/pnl" style={navLink}>
          P&amp;L
        </Link>
        <Link href="/ifta" style={navLink}>
          IFTA
        </Link>
        <Link href="/overhead" style={navLink}>
          Per-truck overhead
        </Link>
        <Link href="/reconciliation" style={navLink}>
          Reconciliation
        </Link>
        <Link href="/chargeback" style={navLink}>
          Chargeback
        </Link>
      </nav>
      <main style={{ padding: '1.5rem' }}>{children}</main>
    </div>
  );
}
