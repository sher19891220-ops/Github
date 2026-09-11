import { Suspense } from 'react';
import { LoginForm } from '@/components/LoginForm';

export default function LoginPage() {
  return (
    <main style={{ padding: '2rem', maxWidth: 560 }}>
      <h1>Sign in</h1>
      <p style={{ color: 'var(--muted)' }}>
        Use the username and password your administrator gave you. You will be asked to set your own
        password the first time you sign in.
      </p>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
