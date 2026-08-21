'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!code.trim()) {
      setError('Enter the access code.');
      return;
    }

    setSubmitting(true);
    const result = await api('/api/auth/login', { method: 'POST', json: { code: code.trim() } });
    setSubmitting(false);

    if (!result.ok) {
      setError(result.data.error ?? 'That code was not accepted.');
      setCode('');
      return;
    }

    const next = params.get('next');
    // Only same-site paths, so a crafted ?next= cannot bounce anyone off-site.
    router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    router.refresh();
  }

  return (
    <div className="login-screen">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand" style={{ paddingBottom: 12 }}>
          <span className="brand-mark" aria-hidden="true">
            DQ
          </span>
          <span style={{ color: '#111827' }}>
            DriverQual
            <span className="brand-sub" style={{ color: 'var(--gray-500)' }}>
              Driver Qualification
            </span>
          </span>
        </div>

        <p className="muted" style={{ marginTop: 0 }}>
          This system holds driver records. Enter the access code to continue.
        </p>

        {error && (
          <div className="alert alert-error" role="alert" data-testid="login-error">
            {error}
          </div>
        )}

        <div className="field">
          <label htmlFor="code">Access code</label>
          <input
            id="code"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            autoFocus
            data-testid="access-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: '100%' }}
          disabled={submitting}
          data-testid="sign-in"
        >
          {submitting ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
