import { ChangePasswordForm } from '@/components/ChangePasswordForm';

export default function ChangePasswordPage() {
  return (
    <main style={{ padding: '2rem', maxWidth: 560 }}>
      <h1>Set your own password</h1>
      <p style={{ color: 'var(--muted)', maxWidth: '34rem' }}>
        The password you were given was sent to you by someone else, so more people and systems have seen
        it than you would choose. It works once, to set a real one. Changing it also signs out every other
        session opened with it.
      </p>
      <ChangePasswordForm />
    </main>
  );
}
