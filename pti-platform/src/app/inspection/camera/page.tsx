'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Check, RotateCcw, ChevronLeft, ChevronRight, AlertCircle, X } from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'
import { INSPECTION_ANGLES } from '@/lib/angles'
import { cn } from '@/lib/utils'
import type { AngleKey, CapturedPhoto } from '@/lib/types'

// Positions 1–13 are required; extras (position 14) is optional/append-only
const MAIN_ANGLES = INSPECTION_ANGLES.filter((a) => a.key !== 'extras')
const REQUIRED_COUNT = MAIN_ANGLES.length

export default function CameraPage() {
  const router = useRouter()
  const { photos, addPhoto, removePhoto, gps, setGPS } = useInspectionStore()
  const [activeIndex, setActiveIndex] = useState(0)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [justCaptured, setJustCaptured] = useState(false)
  const [blurWarning, setBlurWarning] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const totalSlots = INSPECTION_ANGLES.length // 14 (13 required + extras)
  const currentAngleConfig = INSPECTION_ANGLES[activeIndex]
  const activeAngle: AngleKey = currentAngleConfig.key
  const isExtras = activeAngle === 'extras'
  const isTireAngle = activeAngle.startsWith('tire-')
  const hasTemplate = !!currentAngleConfig.template

  const currentPhoto = isExtras ? undefined : photos.find((p) => p.angle === activeAngle)
  const extrasPhotos = photos.filter((p) => p.angle === 'extras')

  const capturedRequired = MAIN_ANGLES.filter((a) => photos.some((p) => p.angle === a.key)).length
  const allCaptured = capturedRequired >= REQUIRED_COUNT

  useEffect(() => {
    if (!gps && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGPS({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: new Date().toISOString(),
          })
        },
        () => {},
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      )
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const startCamera = useCallback(async () => {
    try {
      setCameraError(null)
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop())
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

    const now = new Date()
    const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    const gpsStr = gps ? `${gps.lat.toFixed(4)}, ${gps.lng.toFixed(4)}` : 'GPS unavailable'
    const labelLine = currentAngleConfig.label.replace('\n', ' ')
    const watermark = `📍 ${gpsStr}   🕐 ${dateStr} ${timeStr}   ${labelLine}`

    const barH = Math.round(canvas.height * 0.055)
    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    ctx.fillRect(0, canvas.height - barH, canvas.width, barH)
    ctx.fillStyle = '#ffffff'
    const fontSize = Math.round(barH * 0.52)
    ctx.font = `bold ${fontSize}px Arial, sans-serif`
    ctx.textBaseline = 'middle'
    ctx.fillText(watermark, 16, canvas.height - barH / 2)

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
    const photo: CapturedPhoto = {
      id: Math.random().toString(36).slice(2),
      angle: activeAngle,
      angleLabel: labelLine,
      dataUrl,
      timestamp: now.toISOString(),
      gps: gps ?? undefined,
      blurScore,
      passed: !isBlurry,
    }
    addPhoto(photo)
    setCapturing(false)
    setJustCaptured(true)
    setTimeout(() => setJustCaptured(false), 1000)
  }, [activeAngle, capturing, currentAngleConfig, addPhoto, gps])

  const handleRemovePhoto = () => {
    if (isExtras) {
      if (extrasPhotos.length > 0) {
        const lastId = extrasPhotos[extrasPhotos.length - 1].id
        useInspectionStore.setState((s) => ({
          photos: s.photos.filter((p) => p.id !== lastId),
        }))
      }
    } else {
      removePhoto(activeAngle)
    }
  }

  const goPrev = () => {
    if (activeIndex > 0) setActiveIndex(activeIndex - 1)
  }
  const goNext = () => {
    if (activeIndex < totalSlots - 1) setActiveIndex(activeIndex + 1)
  }

  const canGoPrev = activeIndex > 0
  const canGoNext = activeIndex < totalSlots - 1
  const hasCurrentPhoto = isExtras ? extrasPhotos.length > 0 : !!currentPhoto

  return (
    <div className="flex flex-col h-screen bg-black">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-black border-b border-slate-800 safe-top z-20">
        <button
          onClick={() => router.push('/inspection/start')}
          className="flex h-10 w-10 items-center justify-center text-slate-300"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="text-center">
          {isExtras ? (
            <p className="text-sm font-semibold text-blue-400">Additional Photos</p>
          ) : (
            <>
              <p className="text-xs text-slate-500 uppercase tracking-widest">Photo</p>
              <p className="text-base font-bold text-white">{activeIndex + 1} / {REQUIRED_COUNT}</p>
            </>
          )}
        </div>

        <button
          onClick={() => router.push('/inspection/signature')}
          className="text-xs text-blue-400 font-medium px-2 py-1"
        >
          Skip
        </button>
      </div>

      {/* Camera viewport */}
      <div className="relative flex-1 overflow-hidden">
        {cameraError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-slate-900 p-8 text-center">
            <AlertCircle className="h-12 w-12 text-red-400" />
            <p className="text-sm text-slate-300">{cameraError}</p>
            <button onClick={startCamera} className="btn-primary">Retry Camera</button>
          </div>
        ) : (
          <>
            {/* Live camera feed */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="absolute inset-0 h-full w-full object-cover"
            />

            {cameraReady && (
              <>
                {/* Template overlay for positions 1–9 */}
                {hasTemplate && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={currentAngleConfig.template}
                    src={currentAngleConfig.template!}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover pointer-events-none select-none"
                    style={{ opacity: 0.82 }}
                  />
                )}

                {/* Angle label — top center */}
                <div className="absolute top-4 inset-x-0 flex justify-center pointer-events-none px-6">
                  {isTireAngle ? (
                    // Big directional text for tire shots
                    <div className="rounded-2xl bg-black/75 px-8 py-5 text-center">
                      <p
                        className="text-4xl font-black text-white tracking-wide leading-tight whitespace-pre-line"
                        style={{ textShadow: '0 2px 8px rgba(0,0,0,0.8)' }}
                      >
                        {currentAngleConfig.label}
                      </p>
                    </div>
                  ) : isExtras ? (
                    <div className="rounded-2xl bg-blue-600/85 px-6 py-3 text-center">
                      <p className="text-2xl font-black text-white tracking-widest">+ EXTRAS</p>
                      {extrasPhotos.length > 0 && (
                        <p className="text-sm text-blue-200 mt-1">{extrasPhotos.length} photo{extrasPhotos.length !== 1 ? 's' : ''} taken</p>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-2xl bg-black/70 px-6 py-2.5 text-center">
                      <p className="text-2xl font-black text-white tracking-widest">
                        {currentAngleConfig.label}
                      </p>
                    </div>
                  )}
                </div>

                {/* Captured thumbnail — top right */}
                {hasCurrentPhoto && !justCaptured && (
                  <div className="absolute top-20 right-4 pointer-events-none">
                    <div className={cn(
                      'w-20 h-14 rounded-lg overflow-hidden border-2',
                      isExtras ? 'border-blue-400' : 'border-green-400'
                    )}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={isExtras
                          ? extrasPhotos[extrasPhotos.length - 1].dataUrl
                          : currentPhoto!.dataUrl}
                        alt="captured"
                        className="w-full h-full object-cover"
                      />
                    </div>
                    {isExtras && extrasPhotos.length > 1 && (
                      <div className="absolute bottom-0 right-0 bg-blue-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-tl-lg rounded-br-lg">
                        ×{extrasPhotos.length}
                      </div>
                    )}
                    {!isExtras && (
                      <div className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-green-500">
                        <Check className="h-3 w-3 text-white" />
                      </div>
                    )}
                  </div>
                )}

                {/* Capture flash */}
                {justCaptured && (
                  <div className="absolute inset-0 bg-white/35 pointer-events-none" />
                )}

                {/* Blur warning */}
                {blurWarning && (
                  <div className="absolute bottom-36 inset-x-6 rounded-xl bg-yellow-500/90 px-4 py-2 text-center pointer-events-none">
                    <p className="text-sm font-semibold text-white">⚠ Image may be blurry — retake recommended</p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />

      {/* Bottom controls */}
      <div className="bg-black px-4 pt-3 pb-4 safe-bottom z-20">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1 flex-wrap mb-4">
          {MAIN_ANGLES.map((a, i) => {
            const captured = photos.some((p) => p.angle === a.key)
            const active = i === activeIndex
            return (
              <button
                key={a.key}
                onClick={() => setActiveIndex(i)}
                className={cn(
                  'rounded-full transition-all',
                  active
                    ? 'h-2.5 w-8 ' + (a.key.startsWith('tire-') ? 'bg-amber-400' : 'bg-white')
                    : captured
                    ? 'h-2.5 w-2.5 ' + (a.key.startsWith('tire-') ? 'bg-amber-500' : 'bg-green-400')
                    : 'h-2 w-2 bg-slate-600'
                )}
              />
            )
          })}
          {/* Extras pill */}
          <button
            onClick={() => setActiveIndex(totalSlots - 1)}
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-bold border transition-all',
              activeIndex === totalSlots - 1
                ? 'bg-blue-500 border-blue-500 text-white'
                : extrasPhotos.length > 0
                ? 'bg-blue-400/70 border-blue-400 text-white'
                : 'bg-slate-700 border-slate-600 text-slate-400'
            )}
          >
            {extrasPhotos.length > 0 ? `+${extrasPhotos.length}` : '+'}
          </button>
        </div>

        {/* Nav + shutter row */}
        <div className="flex items-center justify-between">
          {/* Back arrow */}
          <button
            onClick={goPrev}
            disabled={!canGoPrev}
            className="flex h-14 w-14 items-center justify-center rounded-full border border-slate-700 text-slate-300 active:bg-slate-800 disabled:opacity-25 transition-colors"
          >
            <ChevronLeft className="h-8 w-8" />
          </button>

          {/* Shutter */}
          <button
            onClick={capturePhoto}
            disabled={capturing || !cameraReady}
            className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white/10 transition-transform active:scale-95 disabled:opacity-50"
          >
            <div className={cn('h-16 w-16 rounded-full bg-white transition-all', capturing && 'scale-90 bg-slate-300')} />
          </button>

          {/* Forward arrow */}
          <button
            onClick={goNext}
            disabled={!canGoNext}
            className="flex h-14 w-14 items-center justify-center rounded-full border border-slate-700 text-slate-300 active:bg-slate-800 disabled:opacity-25 transition-colors"
          >
            <ChevronRight className="h-8 w-8" />
          </button>
        </div>

        {/* Retake / Continue row */}
        <div className="flex gap-3 mt-3">
          <button
            onClick={handleRemovePhoto}
            disabled={!hasCurrentPhoto}
            className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-700 px-4 text-sm text-slate-400 disabled:opacity-30"
          >
            <RotateCcw className="h-4 w-4" />
            Retake
          </button>

          {allCaptured ? (
            <button
              onClick={() => router.push('/inspection/signature')}
              className="btn-primary flex-1 py-2.5 text-sm"
            >
              <Check className="h-4 w-4" />
              All {REQUIRED_COUNT} Photos — Continue
            </button>
          ) : (
            <button
              onClick={() => router.push('/inspection/signature')}
              className="flex-1 rounded-xl border border-slate-700 py-2.5 text-sm font-medium text-slate-400"
            >
              Skip ({capturedRequired}/{REQUIRED_COUNT})
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function computeBlurScore(imageData: ImageData): number {
  const { data, width, height } = imageData
  let sum = 0, count = 0
  const step = 4
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const i = (y * width + x) * 4
      const rightI = i + 4
      const downI = ((y + 1) * width + x) * 4
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
