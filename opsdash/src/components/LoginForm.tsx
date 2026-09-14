'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = (await res.json()) as { error?: string; mustChangePassword?: boolean };
      if (!res.ok) {
        setError(body.error ?? 'Could not sign in.');
        return;
      }
      router.push(body.mustChangePassword ? '/change-password' : next);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: '22rem' }}>
      <label style={{ display: 'block', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Username</div>
        <input
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
      </label>
      <label style={{ display: 'block', marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Password</div>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
      </label>
      <button type="submit" disabled={busy || username === '' || password === ''}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {error !== null && (
        <p role="alert" style={{ color: 'var(--bad)', marginTop: '0.75rem' }}>
          {error}
        </p>
      )}
    </form>
  );
}
