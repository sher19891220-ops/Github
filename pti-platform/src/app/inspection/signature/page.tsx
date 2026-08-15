'use client'
import { useRef, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, MapPin, Calendar, Truck, User, AlertTriangle } from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'

export default function SignaturePage() {
  const router = useRouter()
  const store = useInspectionStore()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drawing, setDrawing] = useState(false)
  const [hasSig, setHasSig] = useState(false)
  const [certified, setCertified] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const failedItems = store.checklist.filter((i) => i.status === 'FAIL')
  const needsAttentionTires = store.tireInspections.filter((t) => t.condition === 'NEEDS_ATTENTION')

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
  const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const gpsStr = store.gps
    ? `${store.gps.lat.toFixed(5)}, ${store.gps.lng.toFixed(5)}`
    : 'Location unavailable'

  const canSubmit = hasSig && certified

  // Canvas drawing helpers
  function getPos(e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    if ('touches' in e) {
      const t = e.touches[0]
      return { x: (t.clientX - rect.left) * scaleX, y: (t.clientY - rect.top) * scaleY }
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  function startDraw(e: React.MouseEvent | React.TouchEvent) {
    const canvas = canvasRef.current
    if (!canvas) return
    e.preventDefault()
    const ctx = canvas.getContext('2d')!
    const { x, y } = getPos(e, canvas)
    ctx.beginPath()
    ctx.moveTo(x, y)
    setDrawing(true)
  }

  function draw(e: React.MouseEvent | React.TouchEvent) {
    if (!drawing) return
    const canvas = canvasRef.current
    if (!canvas) return
    e.preventDefault()
    const ctx = canvas.getContext('2d')!
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#1e40af'
    const { x, y } = getPos(e, canvas)
    ctx.lineTo(x, y)
    ctx.stroke()
    setHasSig(true)
  }

  function endDraw() { setDrawing(false) }

  function clearSig() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setHasSig(false)
    store.setSignature('')
  }

  function handleSubmit() {
    if (!canSubmit) return
    const canvas = canvasRef.current
    if (!canvas) return
    store.setSignature(canvas.toDataURL('image/png'))
    setSubmitting(true)
    setTimeout(() => router.push('/inspection/complete'), 400)
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      {/* Header */}
      <div className="bg-gradient-to-br from-blue-700 to-blue-900 text-white safe-top">
        <div className="px-4 pt-4 pb-5">
          <div className="flex items-center justify-between mb-1">
            <button onClick={() => router.push('/inspection/checklist')} className="flex items-center gap-1 text-blue-200">
              <ChevronLeft className="h-5 w-5" />
              <span className="text-sm">Checklist</span>
            </button>
            <span className="text-xs text-blue-200">Step 4 of 5</span>
          </div>
          <h1 className="text-xl font-bold">Certification</h1>
          <p className="text-sm text-blue-200 mt-0.5">Review and sign to complete inspection</p>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4">

        {/* Summary card */}
        <div className="card space-y-3">
          <h3 className="font-semibold text-slate-800 mb-1">Inspection Summary</h3>

          <div className="flex items-center gap-2 text-sm text-slate-700">
            <User className="h-4 w-4 text-blue-500 flex-shrink-0" />
            <span className="font-medium">{store.driver?.name ?? '—'}</span>
          </div>

          <div className="flex items-center gap-2 text-sm text-slate-700">
            <Truck className="h-4 w-4 text-blue-500 flex-shrink-0" />
            <span>
              Trailer <span className="font-bold">{store.vehicle?.unitNumber ?? '—'}</span>
              {' · '}
              <span className={`font-bold ${store.inspectionType === 'PICKUP' ? 'text-green-600' : 'text-orange-500'}`}>
                {store.inspectionType === 'PICKUP' ? '▲ PICKUP' : '▼ DROP-OFF'}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-2 text-sm text-slate-700">
            <Calendar className="h-4 w-4 text-blue-500 flex-shrink-0" />
            <span>{dateStr}, {timeStr}</span>
          </div>

          <div className="flex items-center gap-2 text-sm text-slate-700">
            <MapPin className="h-4 w-4 text-blue-500 flex-shrink-0" />
            <span className="font-mono text-xs">{gpsStr}</span>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100">
            <div className="text-center">
              <div className="text-xl font-black text-blue-600">{store.photos.length}</div>
              <div className="text-xs text-slate-500">Photos</div>
            </div>
            <div className="text-center">
              <div className={`text-xl font-black ${failedItems.length > 0 ? 'text-red-500' : 'text-green-500'}`}>
                {failedItems.length}
              </div>
              <div className="text-xs text-slate-500">Failed Items</div>
            </div>
            <div className="text-center">
              <div className={`text-xl font-black ${needsAttentionTires.length > 0 ? 'text-amber-500' : 'text-green-500'}`}>
                {needsAttentionTires.length}
              </div>
              <div className="text-xs text-slate-500">Tire Alerts</div>
            </div>
          </div>
        </div>

        {/* Issues section */}
        {(failedItems.length > 0 || needsAttentionTires.length > 0 || store.comments.trim()) && (
          <div className="card border border-red-100 bg-red-50">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              <h3 className="font-semibold text-red-700">Issues Found</h3>
            </div>

            {failedItems.map((item) => (
              <div key={item.id} className="mb-2">
                <div className="text-sm font-medium text-red-700">✗ {item.label}</div>
                {item.notes && <div className="text-xs text-slate-600 ml-4">{item.notes}</div>}
              </div>
            ))}

            {needsAttentionTires.map((tire) => (
              <div key={tire.position} className="mb-1 text-sm font-medium text-amber-700">
                ⚠ {tire.position} — Needs Attention
              </div>
            ))}

            {store.comments.trim() && (
              <div className="mt-2 pt-2 border-t border-red-200">
                <div className="text-xs font-semibold text-slate-600 mb-1">Additional Comments:</div>
                <div className="text-sm text-slate-700 whitespace-pre-wrap">{store.comments}</div>
              </div>
            )}
          </div>
        )}

        {/* Signature */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-slate-800">Driver Signature</h3>
            {hasSig && (
              <button onClick={clearSig} className="text-xs text-red-500 font-medium">Clear</button>
            )}
          </div>
          <div className="border-2 border-dashed border-slate-300 rounded-xl overflow-hidden bg-white">
            <canvas
              ref={canvasRef}
              width={600}
              height={160}
              className="w-full touch-none"
              style={{ height: '160px' }}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={endDraw}
              onMouseLeave={endDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={endDraw}
            />
          </div>
          {!hasSig && (
            <p className="text-xs text-slate-400 text-center mt-2">Sign above with your finger or mouse</p>
          )}
        </div>

        {/* Certification checkbox */}
        <label className="card flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={certified}
            onChange={(e) => setCertified(e.target.checked)}
            className="mt-0.5 h-5 w-5 rounded accent-blue-600 flex-shrink-0"
          />
          <span className="text-sm text-slate-700 leading-snug">
            I certify that I have inspected this trailer and the information reported above is accurate and true to the best of my knowledge.
          </span>
        </label>

      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 py-3 flex gap-3">
        <button
          onClick={() => router.push('/inspection/checklist')}
          className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl border-2 border-slate-200 text-slate-600 font-semibold"
        >
          <ChevronLeft className="h-5 w-5" />
          Back
        </button>
        <button
          disabled={!canSubmit || submitting}
          onClick={handleSubmit}
          className="flex-1 py-3 rounded-xl bg-blue-600 text-white font-bold text-base disabled:opacity-40"
        >
          {submitting ? 'Submitting…' : 'Submit Inspection'}
        </button>
      </div>
    </div>
  )
}
