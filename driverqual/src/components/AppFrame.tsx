'use client';

import { usePathname } from 'next/navigation';
import { Nav } from './Nav';

/**
 * Chooses the chrome for a route.
 *
 * The login screen deliberately renders bare: showing the navigation to someone
 * who has not signed in advertises the shape of the system and offers links
 * that cannot work.
 */
export function AppFrame({
  children,
  authEnabled,
}: {
  children: React.ReactNode;
  authEnabled: boolean;
}) {
  const pathname = usePathname();

  if (pathname === '/login') return <>{children}</>;

  return (
    <>
      {!authEnabled && (
        <div className="auth-banner" role="status" data-testid="no-auth-banner">
          No access code is configured — anyone who can reach this URL can read and
          change every driver record. Set <code>APP_ACCESS_CODE</code> before using
          this with real data.
        </div>
      )}
      <div className="shell">
        <Nav authEnabled={authEnabled} />
        <main className="main">{children}</main>
      </div>
    </>
  );
}
