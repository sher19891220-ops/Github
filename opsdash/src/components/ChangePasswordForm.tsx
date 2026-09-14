'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ChangePasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm !== '' && confirm !== newPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = (await res.json()) as { error?: string; signedOut?: boolean };
      if (!res.ok) {
        setError(body.error ?? 'Could not change the password.');
        return;
      }
      router.push(body.signedOut ? '/login' : '/');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const field = { width: '100%', boxSizing: 'border-box' as const };
  const label = { fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.25rem' };

  return (
    <form onSubmit={submit} style={{ maxWidth: '22rem' }}>
      <label style={{ display: 'block', marginBottom: '0.75rem' }}>
        <div style={label}>Current password</div>
        <input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} style={field} />
      </label>
      <label style={{ display: 'block', marginBottom: '0.75rem' }}>
        <div style={label}>New password — at least 12 characters</div>
        <input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNext(e.target.value)} style={field} />
      </label>
      <label style={{ display: 'block', marginBottom: '1rem' }}>
        <div style={label}>New password again</div>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={field} />
        {mismatch && <div style={{ color: 'var(--bad)', fontSize: '0.85rem' }}>These do not match.</div>}
      </label>
      <button type="submit" disabled={busy || mismatch || newPassword.length < 12 || currentPassword === ''}>
        {busy ? 'Saving…' : 'Set my password'}
      </button>
      {error !== null && (
        <p role="alert" style={{ color: 'var(--bad)', marginTop: '0.75rem' }}>
          {error}
        </p>
      )}
    </form>
  );
}
