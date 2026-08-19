import { ApplicantsView } from '@/components/ApplicantsView';

export const dynamic = 'force-dynamic';

export default function ApplicantsPage() {
  return (
    <ApplicantsView
      title="Applicants"
      subtitle="Every applicant, with their current company’s coverage decisions."
    />
  );
}
