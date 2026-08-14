'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Check, RotateCcw, ChevronRight, AlertCircle } from 'lucide-react'
import { TopBar } from '@/components/ui/TopBar'
import { useInspectionStore } from '@/store/inspectionStore'
import { INSPECTION_ANGLES } from '@/lib/angles'
import { cn } from '@/lib/utils'
import type { AngleKey, CapturedPhoto } from '@/lib/types'

export default function CameraPage() {
  const router = useRouter()
  const { photos, addPhoto, removePhoto, inspectionType } = useInspectionStore()
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
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.onloadedmetadata = () => setCameraReady(true)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Camera access denied'
      setCameraError(msg)
    }
  }, [])

  useEffect(() => {
    startCamera()
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || capturing) return
    setCapturing(true)
    const video = videoRef.current
    const canvas = canvasRef.current
    canvas.width = video.videoWidth || 1280
    canvas.height = video.videoHeight || 720
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    // Simple blur detection via variance of grayscale
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

    // Auto-advance to next angle
    if (!isBlurry && currentIndex < INSPECTION_ANGLES.length - 1) {
      setTimeout(() => setActiveAngle(INSPECTION_ANGLES[currentIndex + 1].key), 800)
    }
  }, [activeAngle, capturing, currentAngleConfig, currentIndex, addPhoto])

  const nextAngle = () => {
    if (currentIndex < INSPECTION_ANGLES.length - 1) {
      setActiveAngle(INSPECTION_ANGLES[currentIndex + 1].key)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-black">
      <TopBar
        title={`Camera — ${currentAngleConfig.label}`}
        subtitle={`${currentIndex + 1} of ${INSPECTION_ANGLES.length}`}
        showBack
        backHref="/inspection/start"
        className="!bg-black !border-slate-800 !text-white [&_*]:!text-white [&_*]:!text-slate-300"
      />

      {/* Camera Viewfinder */}
      <div className="relative flex-1 overflow-hidden">
        {cameraError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-slate-900 p-8 text-center">
            <AlertCircle className="h-12 w-12 text-red-400" />
            <p className="text-sm text-slate-300">{cameraError}</p>
            <button onClick={startCamera} className="btn-primary">Retry Camera</button>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover"
            />

            {/* Corner guides */}
            {cameraReady && (
              <>
                <div className="camera-overlay">
                  <div className="camera-corner" style={{ top: 24, left: 24, borderTopWidth: 3, borderLeftWidth: 3, borderRightWidth: 0, borderBottomWidth: 0 }} />
                  <div className="camera-corner" style={{ top: 24, right: 24, borderTopWidth: 3, borderRightWidth: 3, borderLeftWidth: 0, borderBottomWidth: 0 }} />
                  <div className="camera-corner" style={{ bottom: 24, left: 24, borderBottomWidth: 3, borderLeftWidth: 3, borderRightWidth: 0, borderTopWidth: 0 }} />
                  <div className="camera-corner" style={{ bottom: 24, right: 24, borderBottomWidth: 3, borderRightWidth: 3, borderLeftWidth: 0, borderTopWidth: 0 }} />
                </div>

                {/* Angle label */}
                <div className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1.5">
                  <p className="text-xs font-semibold text-white text-center">{currentAngleConfig.label.toUpperCase()}</p>
                </div>

                {/* Instruction */}
                <div className="absolute bottom-28 inset-x-4 rounded-xl bg-black/70 px-4 py-3">
                  <p className="text-xs text-white/90 text-center leading-relaxed">{currentAngleConfig.instruction}</p>
                </div>
              </>
            )}

            {/* Flash / capture feedback */}
            {justCaptured && (
              <div className="absolute inset-0 bg-white/30 flex items-center justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500 check-pop">
                  <Check className="h-8 w-8 text-white" />
                </div>
              </div>
            )}

            {/* Blur warning */}
            {blurWarning && (
              <div className="absolute top-16 inset-x-4 rounded-xl bg-yellow-500/90 px-4 py-2 text-center">
                <p className="text-xs font-semibold text-white">Image may be blurry — retake for best results</p>
              </div>
            )}
          </>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />

      {/* Bottom Controls */}
      <div className="bg-black px-4 py-4 space-y-3 safe-bottom">
        {/* Angle Dots */}
        <div className="flex items-center justify-center gap-1.5">
          {INSPECTION_ANGLES.map((a, i) => {
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

        {/* Controls row */}
        <div className="flex items-center justify-between">
          {/* Retake */}
          <button
            onClick={() => { removePhoto(activeAngle); setJustCaptured(false) }}
            disabled={!currentPhoto}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 text-slate-400 disabled:opacity-30"
          >
            <RotateCcw className="h-5 w-5" />
          </button>

          {/* Capture */}
          <button
            onClick={capturePhoto}
            disabled={capturing || !cameraReady}
            className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white/10 transition-transform active:scale-95 disabled:opacity-50"
          >
            <div className={cn('h-16 w-16 rounded-full bg-white transition-all', capturing && 'scale-90')} />
          </button>

          {/* Next / Skip */}
          <button
            onClick={nextAngle}
            disabled={currentIndex >= INSPECTION_ANGLES.length - 1}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 text-slate-400 disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {/* Proceed */}
        {allCaptured && (
          <button
            onClick={() => router.push('/inspection/checklist')}
            className="btn-primary w-full"
          >
            <Check className="h-4 w-4" />
            All photos captured — Next: Checklist
          </button>
        )}

        {!allCaptured && (
          <button
            onClick={() => router.push('/inspection/checklist')}
            className="btn-secondary w-full text-sm py-2.5"
          >
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
      const gray = (data[i] + data[i + 1] + data[i + 2]) / 3
      const right = (data[i + 4] + data[i + 5] + data[i + 6]) / 3
      const down = (data[(y + 1) * width * 4 + x * 4] + data[(y + 1) * width * 4 + x * 4 + 1] + data[(y + 1) * width * 4 + x * 4 + 2]) / 3
      sum += Math.abs(gray - right) + Math.abs(gray - down)
      count++
    }
  }
  return count > 0 ? sum / count : 0
}
