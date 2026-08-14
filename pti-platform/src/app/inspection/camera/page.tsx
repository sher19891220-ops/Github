'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Check, RotateCcw, ChevronRight, AlertCircle } from 'lucide-react'
import { TopBar } from '@/components/ui/TopBar'
import { useInspectionStore } from '@/store/inspectionStore'
import { INSPECTION_ANGLES } from '@/lib/angles'
import { cn } from '@/lib/utils'
import type { AngleKey, CapturedPhoto } from '@/lib/types'

export default function CameraPage() {
  const router = useRouter()
  const { photos, addPhoto, removePhoto } = useInspectionStore()
  const [activeAngle, setActiveAngle] = useState<AngleKey>(INSPECTION_ANGLES[0].key)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [justCaptured, setJustCaptured] = useState(false)
  const [blurWarning, setBlurWarning] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const currentAngleConfig = INSPECTION_ANGLES.find((a) => a.key === activeAngle)!
  const currentIndex = INSPECTION_ANGLES.findIndex((a) => a.key === activeAngle)
  const currentPhoto = photos.find((p) => p.angle === activeAngle)
  const allCaptured = INSPECTION_ANGLES.every((a) => photos.some((p) => p.angle === a.key))

  const startCamera = useCallback(async () => {
    try {
      setCameraError(null)
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.onloadedmetadata = () => setCameraReady(true)
      }
    } catch (err: unknown) {
      setCameraError(err instanceof Error ? err.message : 'Camera access denied')
    }
  }, [])

  useEffect(() => {
    startCamera()
    return () => { streamRef.current?.getTracks().forEach((t) => t.stop()) }
  }, [startCamera])

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || capturing) return
    setCapturing(true)
    const video = videoRef.current
    const canvas = canvasRef.current
    canvas.width = video.videoWidth || 1280
    canvas.height = video.videoHeight || 720
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const blurScore = computeBlurScore(imageData)
    const isBlurry = blurScore < 80

    if (isBlurry) {
      setBlurWarning(true)
      setTimeout(() => setBlurWarning(false), 2500)
    }

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
    const photo: CapturedPhoto = {
      id: Math.random().toString(36).slice(2),
      angle: activeAngle,
      angleLabel: currentAngleConfig.label,
      dataUrl,
      timestamp: new Date().toISOString(),
      blurScore,
      passed: !isBlurry,
    }
    addPhoto(photo)
    setCapturing(false)
    setJustCaptured(true)
    setTimeout(() => setJustCaptured(false), 1200)

    if (!isBlurry && currentIndex < INSPECTION_ANGLES.length - 1) {
      setTimeout(() => setActiveAngle(INSPECTION_ANGLES[currentIndex + 1].key), 800)
    }
  }, [activeAngle, capturing, currentAngleConfig, currentIndex, addPhoto])

  return (
    <div className="flex flex-col h-screen bg-black">
      <TopBar
        title={`Camera — ${currentAngleConfig.label}`}
        subtitle={`${currentIndex + 1} of ${INSPECTION_ANGLES.length}`}
        showBack
        backHref="/inspection/start"
        className="!bg-black !border-slate-800 [&_h1]:!text-white [&_p]:!text-slate-400 [&_button]:!text-slate-300"
      />

      <div className="relative flex-1 overflow-hidden">
        {cameraError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-slate-900 p-8 text-center">
            <AlertCircle className="h-12 w-12 text-red-400" />
            <p className="text-sm text-slate-300">{cameraError}</p>
            <button onClick={startCamera} className="btn-primary">Retry Camera</button>
          </div>
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />

            {cameraReady && (
              <>
                {/* Corner guides */}
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute" style={{ top: 24, left: 24, width: 24, height: 24, borderTop: '3px solid #22c55e', borderLeft: '3px solid #22c55e' }} />
                  <div className="absolute" style={{ top: 24, right: 24, width: 24, height: 24, borderTop: '3px solid #22c55e', borderRight: '3px solid #22c55e' }} />
                  <div className="absolute" style={{ bottom: 160, left: 24, width: 24, height: 24, borderBottom: '3px solid #22c55e', borderLeft: '3px solid #22c55e' }} />
                  <div className="absolute" style={{ bottom: 160, right: 24, width: 24, height: 24, borderBottom: '3px solid #22c55e', borderRight: '3px solid #22c55e' }} />
                </div>

                <div className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1.5">
                  <p className="text-xs font-semibold text-white">{currentAngleConfig.label.toUpperCase()}</p>
                </div>

                <div className="absolute bottom-36 inset-x-4 rounded-xl bg-black/70 px-4 py-3">
                  <p className="text-xs text-white/90 text-center leading-relaxed">{currentAngleConfig.instruction}</p>
                </div>
              </>
            )}

            {justCaptured && (
              <div className="absolute inset-0 bg-white/30 flex items-center justify-center pointer-events-none">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500 check-pop">
                  <Check className="h-8 w-8 text-white" />
                </div>
              </div>
            )}

            {blurWarning && (
              <div className="absolute top-16 inset-x-4 rounded-xl bg-yellow-500/90 px-4 py-2 text-center pointer-events-none">
                <p className="text-xs font-semibold text-white">Image may be blurry — retake for best results</p>
              </div>
            )}
          </>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />

      <div className="bg-black px-4 py-4 space-y-3 safe-bottom">
        <div className="flex items-center justify-center gap-1.5">
          {INSPECTION_ANGLES.map((a) => {
            const captured = photos.some((p) => p.angle === a.key)
            const active = a.key === activeAngle
            return (
              <button
                key={a.key}
                onClick={() => setActiveAngle(a.key)}
                className={cn(
                  'rounded-full transition-all',
                  active ? 'h-3 w-8 bg-white' : captured ? 'h-2.5 w-2.5 bg-green-400' : 'h-2.5 w-2.5 bg-slate-600'
                )}
              />
            )
          })}
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={() => removePhoto(activeAngle)}
            disabled={!currentPhoto}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 text-slate-400 disabled:opacity-30"
          >
            <RotateCcw className="h-5 w-5" />
          </button>

          <button
            onClick={capturePhoto}
            disabled={capturing || !cameraReady}
            className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white/10 transition-transform active:scale-95 disabled:opacity-50"
          >
            <div className={cn('h-16 w-16 rounded-full bg-white transition-all', capturing && 'scale-90')} />
          </button>

          <button
            onClick={() => currentIndex < INSPECTION_ANGLES.length - 1 && setActiveAngle(INSPECTION_ANGLES[currentIndex + 1].key)}
            disabled={currentIndex >= INSPECTION_ANGLES.length - 1}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 text-slate-400 disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {allCaptured ? (
          <button onClick={() => router.push('/inspection/checklist')} className="btn-primary w-full">
            <Check className="h-4 w-4" /> All photos captured — Next: Checklist
          </button>
        ) : (
          <button onClick={() => router.push('/inspection/checklist')} className="btn-secondary w-full text-sm py-2.5">
            Skip to Checklist ({photos.length}/{INSPECTION_ANGLES.length} captured)
          </button>
        )}
      </div>
    </div>
  )
}

function computeBlurScore(imageData: ImageData): number {
  const { data, width, height } = imageData
  let sum = 0
  let count = 0
  const step = 4
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const i = (y * width + x) * 4
      const rightI = i + 4
      const downI = ((y + 1) * width + x) * 4
      // Bounds check
      if (rightI + 2 >= data.length || downI + 2 >= data.length) continue
      const gray = (data[i] + data[i + 1] + data[i + 2]) / 3
      const right = (data[rightI] + data[rightI + 1] + data[rightI + 2]) / 3
      const down = (data[downI] + data[downI + 1] + data[downI + 2]) / 3
      sum += Math.abs(gray - right) + Math.abs(gray - down)
      count++
    }
  }
  return count > 0 ? sum / count : 0
}
