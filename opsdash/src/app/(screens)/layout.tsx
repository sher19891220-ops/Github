import Link from 'next/link';
import type { ReactNode } from 'react';

export default function ScreensLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <nav
        style={{
          display: 'flex',
          gap: '1.25rem',
          padding: '0.75rem 1.5rem',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <Link href="/documents" style={{ color: 'var(--fg)', fontWeight: 600, textDecoration: 'none' }}>
          Documents
        </Link>
        <Link href="/review" style={{ color: 'var(--fg)', fontWeight: 600, textDecoration: 'none' }}>
          Review queue
        </Link>
        <Link href="/overhead" style={{ color: 'var(--fg)', fontWeight: 600, textDecoration: 'none' }}>
          Per-truck overhead
        </Link>
      </nav>
      <main style={{ padding: '1.5rem' }}>{children}</main>
    </div>
  );
}
