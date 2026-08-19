import type { Decision } from '@/domain/types';

const CLASS_BY_DECISION: Record<Decision, string> = {
  Qualified: 'badge badge-qualified',
  'Not Qualified': 'badge badge-not-qualified',
  'Manual Review': 'badge badge-manual-review',
  'Not Evaluated': 'badge badge-not-evaluated',
};

export function DecisionBadge({ decision }: { decision: Decision | undefined }) {
  const value: Decision = decision ?? 'Not Evaluated';
  return <span className={CLASS_BY_DECISION[value]}>{value}</span>;
}
