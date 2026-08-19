'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/applicants', label: 'Applicants' },
  { href: '/manual-reviews', label: 'Manual reviews' },
  { href: '/documents', label: 'Documents' },
  { href: '/companies', label: 'Companies' },
  { href: '/insurance-programs', label: 'Insurance programs' },
  { href: '/guidelines', label: 'Rules & guidelines' },
  { href: '/reports', label: 'Reports' },
  { href: '/audit-log', label: 'Audit log' },
  { href: '/team', label: 'Team & roles' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="topbar">
        <strong>DriverQual</strong>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-expanded={open}
          aria-controls="primary-nav"
          onClick={() => setOpen((v) => !v)}
          data-testid="nav-toggle"
        >
          {open ? 'Close menu' : 'Menu'}
        </button>
      </div>

      <aside className="sidebar" data-open={open ? 'true' : 'false'} id="primary-nav">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            DQ
          </span>
          <span>
            DriverQual
            <span className="brand-sub">Driver Qualification</span>
          </span>
        </div>
        <nav className="nav" aria-label="Primary">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname === link.href ? 'page' : undefined}
              onClick={() => setOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </aside>
    </>
  );
}
