'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X, Minus, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react'
import { TopBar } from '@/components/ui/TopBar'
import { useInspectionStore } from '@/store/inspectionStore'
import { getChecklistCategories, getFailCount, isChecklistComplete } from '@/lib/checklist'
import { cn } from '@/lib/utils'
import type { ChecklistItem, ItemStatus } from '@/lib/types'

export default function ChecklistPage() {
  const router = useRouter()
  const { checklist, updateChecklistItem } = useInspectionStore()
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set(getChecklistCategories(checklist)))
  const [expandedNotes, setExpandedNotes] = useState<string | null>(null)

  const categories = getChecklistCategories(checklist)
  const failCount = getFailCount(checklist)
  const complete = isChecklistComplete(checklist)
  const totalMandatory = checklist.filter((i) => i.mandatory).length
  const doneMandatory = checklist.filter((i) => i.mandatory && i.status !== 'PENDING').length

  const toggleCategory = (cat: string) => {
    setOpenCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-32">
      <TopBar
        title="Inspection Checklist"
        subtitle={`${doneMandatory}/${totalMandatory} mandatory complete`}
        showBack
        backHref="/inspection/camera"
      />

      {/* Progress bar */}
      <div className="sticky top-[57px] z-30 bg-white border-b border-slate-100 px-4 py-2">
        <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
          <span>{doneMandatory}/{totalMandatory} complete</span>
          {failCount > 0 && (
            <span className="flex items-center gap-1 text-red-600 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" />
              {failCount} fail{failCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-100">
          <div
            className="h-1.5 rounded-full bg-blue-600 transition-all"
            style={{ width: `${totalMandatory > 0 ? (doneMandatory / totalMandatory) * 100 : 0}%` }}
          />
        </div>
      </div>

      <div className="divide-y divide-slate-100">
        {categories.map((cat) => {
          const items = checklist.filter((i) => i.category === cat)
          const catFails = items.filter((i) => i.status === 'FAIL').length
          const catDone = items.filter((i) => i.status !== 'PENDING').length
          const isOpen = openCategories.has(cat)

          return (
            <div key={cat}>
              <button
                onClick={() => toggleCategory(cat)}
                className="flex w-full items-center justify-between bg-slate-50 px-4 py-3 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-700">{cat}</span>
                  {catFails > 0 && (
                    <span className="badge-fail"><AlertTriangle className="h-2.5 w-2.5" /> {catFails}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">{catDone}/{items.length}</span>
                  {isOpen ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                </div>
              </button>

              {isOpen && (
                <div className="bg-white">
                  {items.map((item) => (
                    <ChecklistRow
                      key={item.id}
                      item={item}
                      expanded={expandedNotes === item.id}
                      onExpand={() => setExpandedNotes(expandedNotes === item.id ? null : item.id)}
                      onUpdate={(status, notes) => updateChecklistItem(item.id, status, notes)}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Bottom CTA */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 p-4 safe-bottom">
        {failCount > 0 && (
          <div className="mb-3 flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0" />
            <p className="text-xs text-red-600 font-medium">{failCount} item{failCount > 1 ? 's' : ''} failed — document notes for each before continuing</p>
          </div>
        )}
        <button
          onClick={() => router.push('/inspection/signature')}
          disabled={!complete}
          className="btn-primary w-full py-4"
        >
          {complete ? 'Next: Signature →' : `Complete all required items (${totalMandatory - doneMandatory} left)`}
        </button>
      </div>
    </div>
  )
}

function ChecklistRow({
  item,
  expanded,
  onExpand,
  onUpdate,
}: {
  item: ChecklistItem
  expanded: boolean
  onExpand: () => void
  onUpdate: (status: ItemStatus, notes?: string) => void
}) {
  return (
    <div className={cn('border-b border-slate-50', item.status === 'FAIL' && 'bg-red-50/50')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-slate-800 truncate">{item.label}</p>
            {item.mandatory && <span className="text-red-400 text-xs">*</span>}
          </div>
          {item.notes && (
            <p className="text-xs text-slate-500 mt-0.5 truncate">{item.notes}</p>
          )}
        </div>

        {/* Pass / Fail / NA buttons */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => onUpdate('PASS')}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg border text-xs font-bold transition-all',
              item.status === 'PASS'
                ? 'border-green-500 bg-green-500 text-white'
                : 'border-slate-200 bg-white text-slate-400 hover:border-green-400 hover:text-green-600'
            )}
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            onClick={() => { onUpdate('FAIL'); onExpand() }}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg border text-xs font-bold transition-all',
              item.status === 'FAIL'
                ? 'border-red-500 bg-red-500 text-white'
                : 'border-slate-200 bg-white text-slate-400 hover:border-red-400 hover:text-red-600'
            )}
          >
            <X className="h-4 w-4" />
          </button>
          <button
            onClick={() => onUpdate('NA')}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg border text-xs font-bold transition-all',
              item.status === 'NA'
                ? 'border-slate-500 bg-slate-500 text-white'
                : 'border-slate-200 bg-white text-slate-400'
            )}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Notes expansion (auto-open on FAIL) */}
      {(expanded || item.status === 'FAIL') && (
        <div className="px-4 pb-3">
          <textarea
            rows={2}
            placeholder={item.status === 'FAIL' ? 'Describe the issue… (required)' : 'Add notes (optional)…'}
            value={item.notes || ''}
            onChange={(e) => onUpdate(item.status, e.target.value)}
            className="input-field text-sm resize-none"
          />
        </div>
      )}
    </div>
  )
}
