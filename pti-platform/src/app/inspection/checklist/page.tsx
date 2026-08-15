'use client'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle } from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'
import { getChecklistCategories, isChecklistComplete } from '@/lib/checklist'
import type { TireCondition } from '@/lib/types'

const TIRE_CONDITIONS: { value: TireCondition; label: string; activeClass: string }[] = [
  { value: 'GOOD',            label: 'GOOD',       activeClass: 'bg-green-500 text-white border-green-500' },
  { value: 'FAIR',            label: 'FAIR',        activeClass: 'bg-yellow-400 text-white border-yellow-400' },
  { value: 'NEEDS_ATTENTION', label: 'NEEDS ATTN', activeClass: 'bg-red-500 text-white border-red-500' },
]

export default function ChecklistPage() {
  const router = useRouter()
  const store = useInspectionStore()

  const categories = getChecklistCategories(store.checklist)
  const allMandatoryDone = isChecklistComplete(store.checklist)
  const tiresAllDone = store.tireInspections.every((t) => t.condition !== null && t.psi.trim() !== '')
  const canProceed = allMandatoryDone && tiresAllDone

  const tiresDone = store.tireInspections.filter((t) => t.condition !== null && t.psi.trim() !== '').length

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
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
                  {catFail > 0 && <span className="ml-1 text-red-500 font-bold"> · {catFail} FAIL</span>}
                </span>
              </div>
              <div className="divide-y divide-slate-100">
                {items.map((item) => (
                  <div key={item.id} className="py-3 first:pt-0 last:pb-0">
                    {/* Label row */}
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm font-medium text-slate-800 leading-tight flex-1">
                        {item.label}
                        {item.mandatory && <span className="ml-1 text-red-400 text-xs">*</span>}
                      </span>
                    </div>
                    {/* Always-visible PASS / FAIL / N/A buttons */}
                    <div className="flex gap-2">
                      {(['PASS', 'FAIL', 'NA'] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() => store.updateChecklistItem(item.id, s)}
                          className={`flex-1 py-2.5 rounded-xl text-sm font-bold border-2 transition-all ${
                            item.status === s
                              ? s === 'PASS' ? 'bg-green-500 border-green-500 text-white'
                              : s === 'FAIL' ? 'bg-red-500 border-red-500 text-white'
                              : 'bg-slate-400 border-slate-400 text-white'
                              : 'bg-white border-slate-200 text-slate-500'
                          }`}
                        >
                          {s === 'PASS' ? '✓ PASS' : s === 'FAIL' ? '✗ FAIL' : '— N/A'}
                        </button>
                      ))}
                    </div>
                    {/* Notes textarea — only when FAIL */}
                    {item.status === 'FAIL' && (
                      <textarea
                        placeholder="Describe the issue..."
                        value={item.notes ?? ''}
                        onChange={(e) => store.updateChecklistItem(item.id, item.status, e.target.value)}
                        className="mt-2 w-full text-sm border border-red-200 rounded-xl p-3 resize-none focus:outline-none focus:ring-2 focus:ring-red-300 bg-red-50"
                        rows={2}
                      />
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
            <span className="text-xs text-slate-500">{tiresDone}/8 done</span>
          </div>

          <div className="space-y-4">
            {/* Axle 1 */}
            <div>
              <div className="text-xs font-black text-slate-500 uppercase tracking-widest mb-2 text-center">
                — AXLE 1 —
              </div>
              <div className="grid grid-cols-2 gap-3">
                {store.tireInspections.slice(0, 4).map((tire) => (
                  <TireCard
                    key={tire.position}
                    tire={tire}
                    onCondition={(c) => store.updateTireCondition(tire.position, c)}
                    onPsi={(p) => store.updateTirePsi(tire.position, p)}
                  />
                ))}
              </div>
            </div>

            {/* Axle 2 */}
            <div>
              <div className="text-xs font-black text-slate-500 uppercase tracking-widest mb-2 text-center">
                — AXLE 2 —
              </div>
              <div className="grid grid-cols-2 gap-3">
                {store.tireInspections.slice(4, 8).map((tire) => (
                  <TireCard
                    key={tire.position}
                    tire={tire}
                    onCondition={(c) => store.updateTireCondition(tire.position, c)}
                    onPsi={(p) => store.updateTirePsi(tire.position, p)}
                  />
                ))}
              </div>
            </div>
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
          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
            <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700">
              Complete all mandatory items (*) and all 8 tire inspections (condition + PSI) to continue.
            </p>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 py-3 flex gap-3">
        <button
          onClick={() => router.push('/inspection/camera')}
          className="flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl border-2 border-slate-200 text-slate-600 font-semibold"
        >
          <ChevronLeft className="h-5 w-5" />
          Back
        </button>
        <button
          disabled={!canProceed}
          onClick={() => router.push('/inspection/signature')}
          className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl bg-blue-600 text-white font-bold disabled:opacity-40"
        >
          Next
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}

function TireCard({
  tire,
  onCondition,
  onPsi,
}: {
  tire: { position: string; condition: TireCondition | null; psi: string }
  onCondition: (c: TireCondition) => void
  onPsi: (p: string) => void
}) {
  const shortLabel = tire.position.replace(/Axle \d — /, '')
  const isDone = tire.condition !== null && tire.psi.trim() !== ''

  return (
    <div className={`rounded-2xl p-3 border-2 transition-all ${isDone ? 'border-green-200 bg-green-50' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-slate-700 leading-tight">{shortLabel}</span>
        {isDone && <CheckCircle2 className="h-4 w-4 text-green-500" />}
      </div>

      {/* Condition buttons */}
      <div className="flex flex-col gap-1 mb-2">
        {TIRE_CONDITIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onCondition(opt.value)}
            className={`w-full py-1.5 rounded-lg text-xs font-bold border-2 transition-all ${
              tire.condition === opt.value
                ? opt.activeClass
                : 'bg-white border-slate-200 text-slate-500'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* PSI input */}
      <div className="flex items-center gap-1.5 bg-slate-50 rounded-lg px-2 py-1.5 border border-slate-200">
        <span className="text-xs text-slate-400 font-medium">PSI</span>
        <input
          type="number"
          inputMode="numeric"
          placeholder="0"
          value={tire.psi}
          onChange={(e) => onPsi(e.target.value)}
          className="flex-1 bg-transparent text-sm font-bold text-slate-800 w-0 min-w-0 outline-none"
          min="0"
          max="200"
        />
        <span className="text-xs text-slate-400">psi</span>
      </div>

      {/* PSI indicator */}
      {tire.psi.trim() !== '' && (() => {
        const val = Number(tire.psi)
        const ok = val >= 90
        return (
          <div className={`mt-1.5 flex items-center gap-1.5 rounded-lg px-2 py-1 ${ok ? 'bg-green-50' : 'bg-red-50'}`}>
            <span className={`h-2 w-2 rounded-full flex-shrink-0 ${ok ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className={`text-xs font-bold ${ok ? 'text-green-700' : 'text-red-700'}`}>
              {ok ? 'OK' : 'VIOLATION'}
            </span>
          </div>
        )
      })()}
    </div>
  )
}
