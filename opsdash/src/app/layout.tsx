import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Accounting — Ops Dashboard',
  description: 'Ingestion, review and reconciliation for the accounting team',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
