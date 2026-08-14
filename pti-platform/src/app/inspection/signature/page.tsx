'use client'
import { useRef, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { RotateCcw, PenLine, Check } from 'lucide-react'
import { TopBar } from '@/components/ui/TopBar'
import { useInspectionStore } from '@/store/inspectionStore'
import { formatDate } from '@/lib/utils'

export default function SignaturePage() {
  const router = useRouter()
  const { driver, vehicle, inspectionType, signatureDataUrl, setSignature, checklist, photos } = useInspectionStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drawing, setDrawing] = useState(false)
  const [hasStrokes, setHasStrokes] = useState(false)
  const [agreed, setAgreed] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.strokeStyle = '#1e3a8a'
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (signatureDataUrl) {
      const img = new Image()
      img.onload = () => ctx.drawImage(img, 0, 0)
      img.src = signatureDataUrl
    }
  }, [])

  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (canvasRef.current!.width / rect.width),
      y: (e.clientY - rect.top) * (canvasRef.current!.height / rect.height),
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrawing(true)
    setHasStrokes(true)
    const ctx = canvasRef.current!.getContext('2d')!
    const { x, y } = getPoint(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing) return
    const ctx = canvasRef.current!.getContext('2d')!
    const { x, y } = getPoint(e)
    ctx.lineTo(x, y)
    ctx.stroke()
  }

  const onPointerUp = () => {
    setDrawing(false)
    if (canvasRef.current) {
      setSignature(canvasRef.current.toDataURL('image/png'))
    }
  }

  const clear = () => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setHasStrokes(false)
    setSignature('')
  }

  const canSubmit = hasStrokes && agreed

  const failCount = checklist.filter((i) => i.status === 'FAIL').length

  return (
    <div className="min-h-screen bg-slate-50 pb-8">
      <TopBar title="Driver Signature" subtitle="Review & sign to submit" showBack backHref="/inspection/checklist" />

      <div className="px-4 py-4 space-y-4">
        {/* Summary card */}
        <div className="card">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Inspection Summary</h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <p className="text-xs text-slate-400">Driver</p>
              <p className="font-semibold text-slate-800">{driver?.name}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Unit #</p>
              <p className="font-semibold text-slate-800">{vehicle?.unitNumber}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Type</p>
              <p className="font-semibold text-slate-800">{inspectionType === 'PICKUP' ? 'Pickup' : 'Drop-off'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Date</p>
              <p className="font-semibold text-slate-800">{formatDate(new Date().toISOString())}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Photos</p>
              <p className="font-semibold text-slate-800">{photos.length} captured</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Issues</p>
              <p className={`font-semibold ${failCount > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {failCount > 0 ? `${failCount} item${failCount > 1 ? 's' : ''} failed` : 'No issues'}
              </p>
            </div>
          </div>
        </div>

        {/* Signature Pad */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <PenLine className="h-4 w-4" />
              Driver Signature
            </label>
            <button onClick={clear} className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-500 transition-colors">
              <RotateCcw className="h-3.5 w-3.5" />
              Clear
            </button>
          </div>

          <div className="relative rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 overflow-hidden" style={{ height: 200 }}>
            {!hasStrokes && (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-slate-300">
                <PenLine className="h-8 w-8 mb-2" />
                <p className="text-sm">Sign here</p>
              </div>
            )}
            <canvas
              ref={canvasRef}
              width={800}
              height={200}
              className="h-full w-full touch-none cursor-crosshair"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          </div>

          {/* Signature line */}
          <div className="mt-2 border-t-2 border-slate-300 pt-1">
            <p className="text-xs text-slate-400 text-center">{driver?.name} · {formatDate(new Date().toISOString())}</p>
          </div>
        </div>

        {/* Agreement */}
        <label className="flex items-start gap-3 card cursor-pointer">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 h-5 w-5 rounded border-slate-300 text-blue-600 flex-shrink-0"
          />
          <p className="text-xs text-slate-600 leading-relaxed">
            I certify that this vehicle has been inspected in accordance with FMCSA regulations and that the information provided above is true and accurate to the best of my knowledge.
          </p>
        </label>

        <button
          disabled={!canSubmit}
          onClick={() => router.push('/inspection/complete')}
          className="btn-primary w-full py-4 text-base"
        >
          <Check className="h-5 w-5" />
          Submit Inspection
        </button>
      </div>
    </div>
  )
}
