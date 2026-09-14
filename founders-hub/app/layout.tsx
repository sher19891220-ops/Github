import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Founders Hub — Apply',
  description: 'Founders Hub membership application',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
