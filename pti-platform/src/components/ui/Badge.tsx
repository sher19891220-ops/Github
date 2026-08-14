import { cn } from '@/lib/utils'
import type { InspectionType, InspectionStatus } from '@/lib/types'

export function InspectionTypeBadge({ type }: { type: InspectionType }) {
  return (
    <span className={type === 'PICKUP' ? 'badge-pickup' : 'badge-dropoff'}>
      {type === 'PICKUP' ? '▲ Pickup' : '▼ Drop-off'}
    </span>
  )
}

export function StatusBadge({ status }: { status: InspectionStatus }) {
  const map: Record<InspectionStatus, { label: string; className: string }> = {
    PENDING: { label: 'Pending', className: 'bg-slate-100 text-slate-600' },
    IN_PROGRESS: { label: 'In Progress', className: 'bg-blue-100 text-blue-700' },
    SUBMITTED: { label: 'Submitted', className: 'bg-green-100 text-green-700' },
    REVIEWED: { label: 'Reviewed', className: 'bg-purple-100 text-purple-700' },
  }
  const { label, className } = map[status]
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', className)}>
      {label}
    </span>
  )
}

export function CompanyBadge({ company }: { company: string }) {
  const colors: Record<string, string> = {
    'Zone LLC': 'bg-blue-100 text-blue-700',
    'Xtrack LLC': 'bg-violet-100 text-violet-700',
    'AFG Transportco': 'bg-amber-100 text-amber-700',
  }
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', colors[company] || 'bg-slate-100 text-slate-600')}>
      {company}
    </span>
  )
}
