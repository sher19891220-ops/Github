'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Filter, Download, AlertTriangle } from 'lucide-react'
import { TopBar } from '@/components/ui/TopBar'
import { InspectionTypeBadge, StatusBadge, CompanyBadge } from '@/components/ui/Badge'
import { MOCK_INSPECTIONS } from '@/lib/mockData'
import { formatDateTime } from '@/lib/utils'
import type { InspectionSummary } from '@/lib/types'

export default function HistoryPage() {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'ALL' | 'PICKUP' | 'DROP_OFF'>('ALL')

  const filtered = MOCK_INSPECTIONS.filter((ins) => {
    const matchSearch =
      !search ||
      ins.unitNumber.toLowerCase().includes(search.toLowerCase()) ||
      ins.driverName.toLowerCase().includes(search.toLowerCase())
    const matchFilter = filter === 'ALL' || ins.type === filter
    return matchSearch && matchFilter
  })

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <TopBar title="Inspection History" showBack backHref="/" />

      {/* Search */}
      <div className="sticky top-[57px] z-30 bg-white border-b border-slate-100 px-4 py-3 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="search"
            placeholder="Search unit, driver…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-field pl-9 py-2.5 text-sm"
          />
        </div>
        <div className="flex gap-2">
          {(['ALL', 'PICKUP', 'DROP_OFF'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                filter === f
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {f === 'ALL' ? 'All' : f === 'PICKUP' ? 'Pickups' : 'Drop-offs'}
            </button>
          ))}
          <span className="ml-auto text-xs text-slate-400 self-center">{filtered.length} records</span>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-slate-400">
            <Filter className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No inspections found</p>
          </div>
        ) : (
          filtered.map((ins) => <InspectionCard key={ins.id} ins={ins} />)
        )}
      </div>
    </div>
  )
}

function InspectionCard({ ins }: { ins: InspectionSummary }) {
  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-bold text-slate-900">{ins.unitNumber}</p>
            <InspectionTypeBadge type={ins.type} />
          </div>
          <p className="text-sm text-slate-600 mt-0.5">{ins.driverName}</p>
        </div>
        <StatusBadge status={ins.status} />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <CompanyBadge company={ins.company} />
        <span className="text-xs text-slate-400">
          {ins.submittedAt ? formatDateTime(ins.submittedAt) : formatDateTime(ins.createdAt)}
        </span>
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 pt-2">
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span>📷 {ins.photoCount} photos</span>
          {ins.failCount > 0 && (
            <span className="flex items-center gap-1 text-red-600 font-semibold">
              <AlertTriangle className="h-3 w-3" />
              {ins.failCount} fail{ins.failCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        {ins.hasPdf && (
          <button className="flex items-center gap-1 text-xs text-blue-600 font-medium">
            <Download className="h-3.5 w-3.5" />
            PDF
          </button>
        )}
      </div>
    </div>
  )
}
