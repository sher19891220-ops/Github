'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useInspectionStore } from '@/store/inspectionStore'
import { getChecklistCategories, getFailCount, isChecklistComplete } from '@/lib/checklist'
import type { ChecklistItem } from '@/lib/types'

export default function ChecklistPage() {
  const router = useRouter()
  const {
    checklist,
    updateChecklistItem,
    addChecklistItem,
    inspectionType,
    vehicle,
    sessionToken,
  } = useInspectionStore()

  const [openCat, setOpenCat] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')

  const categories = useMemo(() => getChecklistCategories(checklist), [checklist])

  useEffect(() => {
    if (!sessionToken) router.replace('/inspection/start')
  }, [sessionToken, router])

  useEffect(() => {
    if (openCat === null && categories.length > 0) setOpenCat(categories[0])
  }, [categories, openCat])

  const failCount = getFailCount(checklist)
  const complete = isChecklistComplete(checklist)
  const doneCount = checklist.filter((i) => i.status !== 'PENDING').length

  const catStats = (cat: string) => {
    const items = checklist.filter((i) => i.category === cat)
    return {
      total: items.length,
      done: items.filter((i) => i.status !== 'PENDING').length,
      failed: items.filter((i) => i.status === 'FAIL').length,
    }
  }

  const setStatus = (item: ChecklistItem, status: ChecklistItem['status']) => {
    updateChecklistItem(item.id, status, item.notes)
    if (status === 'FAIL') {
      setNoteFor(item.id)
      setNoteText(item.notes || '')
    }
  }

  const saveNote = () => {
    if (!noteFor) return
    const item = checklist.find((i) => i.id === noteFor)
    if (item) updateChecklistItem(item.id, item.status, noteText.trim())
    setNoteFor(null)
    setNoteText('')
  }

  const saveCustom = () => {
    const label = newLabel.trim()
    if (!label || !addingTo) return
    addChecklistItem({
      id: `custom-${Date.now()}`,
      category: addingTo,
      label,
      mandatory: false,
      status: 'PENDING',
      notes: '',
    })
    setNewLabel('')
    setAddingTo(null)
  }

  const TRAILER_TYPE_LABELS: Record<string, string> = {
    DRY_VAN: 'Dry Van', REEFER: 'Reefer', FLATBED: 'Flatbed', STEPDECK: 'Stepdeck',
  }

  const title = (() => {
    const t = inspectionType || ''
    const movement = t.includes('PICKUP') ? 'Pickup' : 'Drop-off'
    if (t.startsWith('TRUCK')) {
      const mode = t.endsWith('DAILY') ? 'Daily PTI' : 'Full Inspection'
      return `Truck ${movement} — ${mode}`
    }
    if (t.startsWith('TRAILER')) {
      const trailerKey = Object.keys(TRAILER_TYPE_LABELS).find((k) => t.includes(k))
      const trailerLabel = trailerKey ? TRAILER_TYPE_LABELS[trailerKey] : 'Trailer'
      return `${trailerLabel} ${movement} Inspection`
    }
    return 'Inspection'
  })()

  return (
    <div className="min-h-screen bg-slate-100 pb-28">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-blue-700 px-4 py-3 text-white shadow-md">
        <div className="flex items-center justify-between">
          <button onClick={() => router.push('/inspection/camera')} className="text-sm text-blue-200">
            ← Photos
          </button>
          <div className="text-center">
            <p className="text-sm font-black leading-tight">{title}</p>
            {vehicle?.unitNumber && (
              <p className="text-[11px] text-blue-200">Unit #{vehicle.unitNumber}</p>
            )}
          </div>
          <div className="w-14 text-right text-xs font-bold">
            {doneCount}/{checklist.length}
          </div>
        </div>
        {failCount > 0 && (
          <p className="mt-1 text-center text-xs font-bold text-red-200">
            {failCount} item{failCount > 1 ? 's' : ''} need repair
          </p>
        )}
      </div>

      {/* Categories */}
      <div className="space-y-2 p-3">
        {categories.map((cat) => {
          const s = catStats(cat)
          const open = openCat === cat
          return (
            <div key={cat} className="overflow-hidden rounded-xl bg-white shadow-sm">
              <button
                onClick={() => setOpenCat(open ? null : cat)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-black text-slate-800">{cat}</span>
                <span className="flex items-center gap-2">
                  {s.failed > 0 && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700">
                      {s.failed}
                    </span>
                  )}
                  <span
                    className={`text-[11px] font-bold ${
                      s.done === s.total ? 'text-green-600' : 'text-slate-400'
                    }`}
                  >
                    {s.done}/{s.total}
                  </span>
                  <span className="text-slate-400">{open ? '▾' : '▸'}</span>
                </span>
              </button>

              {open && (
                <div className="border-t border-slate-100">
                  {checklist
                    .filter((i) => i.category === cat)
                    .map((item) => (
                      <div key={item.id} className="border-b border-slate-50 px-4 py-2.5 last:border-0">
                        <div className="flex items-center justify-between gap-3">
                          <span className="flex-1 text-[13px] leading-snug text-slate-700">
                            {item.label}
                            {!item.mandatory && (
                              <span className="ml-1 text-[10px] text-slate-400">(optional)</span>
                            )}
                          </span>
                          <div className="flex shrink-0 gap-1.5">
                            <button
                              onClick={() => setStatus(item, 'PASS')}
                              className={`rounded-lg px-3 py-1.5 text-[11px] font-black ${
                                item.status === 'PASS'
                                  ? 'bg-green-500 text-white'
                                  : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              OK
                            </button>
                            <button
                              onClick={() => setStatus(item, 'FAIL')}
                              className={`rounded-lg px-3 py-1.5 text-[11px] font-black ${
                                item.status === 'FAIL'
                                  ? 'bg-red-500 text-white'
                                  : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              REPAIR
                            </button>
                          </div>
                        </div>
                        {item.status === 'FAIL' && item.notes && (
                          <p className="mt-1 text-[11px] italic text-red-600">{item.notes}</p>
                        )}
                      </div>
                    ))}

                  {/* Add a custom check to this section */}
                  {addingTo === cat ? (
                    <div className="flex gap-2 bg-slate-50 px-4 py-3">
                      <input
                        autoFocus
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && saveCustom()}
                        placeholder="Describe the check"
                        className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-[13px]"
                      />
                      <button
                        onClick={saveCustom}
                        className="rounded-lg bg-blue-600 px-3 py-2 text-[12px] font-bold text-white"
                      >
                        Add
                      </button>
                      <button
                        onClick={() => { setAddingTo(null); setNewLabel('') }}
                        className="rounded-lg bg-slate-200 px-3 py-2 text-[12px] font-bold text-slate-600"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setAddingTo(cat)}
                      className="w-full bg-slate-50 px-4 py-2.5 text-left text-[12px] font-bold text-blue-600"
                    >
                      ＋ Add check to {cat}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Note modal for a failed item */}
      {noteFor && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/50" onClick={() => saveNote()}>
          <div
            className="w-full rounded-t-2xl bg-white p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-2 text-sm font-black text-slate-800">What&apos;s wrong?</p>
            <textarea
              autoFocus
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={3}
              placeholder="Describe the issue so the shop knows what to look at"
              className="w-full rounded-xl border border-slate-300 p-3 text-sm"
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={saveNote}
                className="flex-1 rounded-xl bg-blue-600 py-3 text-sm font-black text-white"
              >
                Save
              </button>
              <button
                onClick={() => { setNoteFor(null); setNoteText('') }}
                className="rounded-xl bg-slate-200 px-5 py-3 text-sm font-black text-slate-600"
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Continue */}
      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-3">
        <button
          onClick={() => router.push('/inspection/signature')}
          disabled={!complete}
          className={`w-full rounded-xl py-4 text-base font-black ${
            complete ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-400'
          }`}
        >
          {complete
            ? 'Continue to Signature →'
            : `${checklist.filter((i) => i.mandatory && i.status === 'PENDING').length} required items left`}
        </button>
      </div>
    </div>
  )
}
