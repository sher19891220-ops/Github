import type { Metadata } from 'next';
import './globals.css';
import { AppFrame } from '@/components/AppFrame';
import { isAuthEnabled } from '@/server/auth';

export const metadata: Metadata = {
  title: 'DriverQual — Driver Qualification Platform',
  description:
    'Evidence-based, company-specific driver qualification for trucking safety departments.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </head>
      <body>
        <AppFrame authEnabled={isAuthEnabled()}>{children}</AppFrame>
      </body>
    </html>
  );
}
