'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, CheckCircle2, XCircle, MinusCircle, AlertTriangle } from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'
import { getChecklistCategories, isChecklistComplete } from '@/lib/checklist'
import type { TireCondition } from '@/lib/types'

const TIRE_CONDITION_OPTIONS: { value: TireCondition; label: string; color: string }[] = [
  { value: 'GOOD',            label: 'GOOD',            color: 'bg-green-500 text-white' },
  { value: 'FAIR',            label: 'FAIR',            color: 'bg-yellow-400 text-white' },
  { value: 'NEEDS_ATTENTION', label: 'NEEDS ATTENTION', color: 'bg-red-500 text-white' },
]

function statusIcon(status: string) {
  if (status === 'PASS') return <CheckCircle2 className="h-5 w-5 text-green-500" />
  if (status === 'FAIL') return <XCircle className="h-5 w-5 text-red-500" />
  if (status === 'NA')   return <MinusCircle className="h-5 w-5 text-slate-400" />
  return <div className="h-5 w-5 rounded-full border-2 border-slate-300" />
}

export default function ChecklistPage() {
  const router = useRouter()
  const store = useInspectionStore()
  const [expandedItem, setExpandedItem] = useState<string | null>(null)

  const categories = getChecklistCategories(store.checklist)
  const allMandatoryDone = isChecklistComplete(store.checklist)
  const tiresAllDone = store.tireInspections.every((t) => t.condition !== null)
  const canProceed = allMandatoryDone && tiresAllDone

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      {/* Header */}
      <div className="bg-gradient-to-br from-blue-700 to-blue-900 text-white safe-top">
        <div className="px-4 pt-4 pb-5">
          <div className="flex items-center justify-between mb-1">
            <button onClick={() => router.push('/inspection/camera')} className="flex items-center gap-1 text-blue-200">
              <ChevronLeft className="h-5 w-5" />
              <span className="text-sm">Camera</span>
            </button>
            <span className="text-xs text-blue-200">Step 3 of 5</span>
          </div>
          <h1 className="text-xl font-bold">Inspection Checklist</h1>
          <p className="text-sm text-blue-200 mt-0.5">
            {store.vehicle?.unitNumber} · {store.driver?.name}
          </p>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4">

        {/* Checklist categories */}
        {categories.map((cat) => {
          const items = store.checklist.filter((i) => i.category === cat)
          const catFail = items.filter((i) => i.status === 'FAIL').length
          const catDone = items.filter((i) => i.status !== 'PENDING').length

          return (
            <div key={cat} className="card">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-slate-800">{cat}</h3>
                <span className="text-xs text-slate-500">
                  {catDone}/{items.length}
                  {catFail > 0 && <span className="ml-1 text-red-500 font-bold">{catFail} FAIL</span>}
                </span>
              </div>
              <div className="space-y-2">
                {items.map((item) => (
                  <div key={item.id}>
                    <div
                      className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 cursor-pointer"
                      onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}
                    >
                      {statusIcon(item.status)}
                      <span className="flex-1 text-sm text-slate-700">
                        {item.label}
                        {item.mandatory && <span className="ml-1 text-red-400 text-xs">*</span>}
                      </span>
                    </div>

                    {expandedItem === item.id && (
                      <div className="ml-8 mt-1 mb-2 space-y-2">
                        <div className="flex gap-2">
                          {(['PASS', 'FAIL', 'NA'] as const).map((s) => (
                            <button
                              key={s}
                              onClick={() => store.updateChecklistItem(item.id, s)}
                              className={`flex-1 py-2 rounded-lg text-sm font-bold border-2 transition-all ${
                                item.status === s
                                  ? s === 'PASS' ? 'bg-green-500 border-green-500 text-white'
                                  : s === 'FAIL' ? 'bg-red-500 border-red-500 text-white'
                                  : 'bg-slate-400 border-slate-400 text-white'
                                  : 'bg-white border-slate-200 text-slate-600'
                              }`}
                            >
                              {s === 'PASS' ? '✓ PASS' : s === 'FAIL' ? '✗ FAIL' : '— N/A'}
                            </button>
                          ))}
                        </div>
                        {item.status === 'FAIL' && (
                          <textarea
                            placeholder="Describe the issue..."
                            value={item.notes ?? ''}
                            onChange={(e) => store.updateChecklistItem(item.id, item.status, e.target.value)}
                            className="w-full text-sm border border-slate-200 rounded-lg p-2 resize-none"
                            rows={2}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}

        {/* Tire Inspection */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-slate-800">Tire Inspection</h3>
            <span className="text-xs text-slate-500">
              {store.tireInspections.filter((t) => t.condition !== null).length}/8 done
            </span>
          </div>

          {/* Axle diagram label */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="text-center text-xs font-bold text-slate-500 uppercase tracking-wide">AXLE 1</div>
            <div className="text-center text-xs font-bold text-slate-500 uppercase tracking-wide">AXLE 2</div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {[0, 1].map((axle) => {
              const axleTires = store.tireInspections.filter((_, i) => Math.floor(i / 4) === axle)
              return (
                <div key={axle} className="space-y-2">
                  {axleTires.map((tire) => {
                    const shortLabel = tire.position.replace(/Axle \d — /, '')
                    return (
                      <div key={tire.position} className="bg-slate-50 rounded-xl p-2">
                        <div className="text-xs font-semibold text-slate-600 mb-1.5 text-center">{shortLabel}</div>
                        <div className="flex flex-col gap-1">
                          {TIRE_CONDITION_OPTIONS.map((opt) => (
                            <button
                              key={opt.value}
                              onClick={() => store.updateTireCondition(tire.position, opt.value)}
                              className={`w-full py-1.5 rounded-lg text-xs font-bold transition-all ${
                                tire.condition === opt.value
                                  ? opt.color + ' shadow-sm'
                                  : 'bg-white border border-slate-200 text-slate-500'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>

        {/* Comments / Issues */}
        <div className="card">
          <h3 className="font-semibold text-slate-800 mb-3">Comments / Issues</h3>
          <textarea
            placeholder="Note any additional issues, damage, or observations..."
            value={store.comments}
            onChange={(e) => store.setComments(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-xl p-3 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
            rows={4}
          />
        </div>

        {!canProceed && (
          <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
            <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
            <p className="text-xs text-amber-700">
              Complete all mandatory checklist items (*) and all 8 tire inspections to proceed.
            </p>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 py-3 flex gap-3">
        <button
          onClick={() => router.push('/inspection/camera')}
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-slate-200 text-slate-600 font-semibold"
        >
          <ChevronLeft className="h-5 w-5" />
          Back
        </button>
        <button
          disabled={!canProceed}
          onClick={() => router.push('/inspection/signature')}
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 text-white font-semibold disabled:opacity-40"
        >
          Next
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
