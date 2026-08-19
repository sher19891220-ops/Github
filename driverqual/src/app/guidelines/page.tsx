import { Suspense } from 'react';
import { GuidelinesView } from '@/components/GuidelinesView';

export const dynamic = 'force-dynamic';

export default function GuidelinesPage() {
  return (
    <Suspense fallback={<p className="muted">Loading guidelines…</p>}>
      <GuidelinesView />
    </Suspense>
  );
}
