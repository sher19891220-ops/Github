'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Check, RotateCcw, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'
import { INSPECTION_ANGLES } from '@/lib/angles'
import { cn } from '@/lib/utils'
import type { AngleKey, CapturedPhoto } from '@/lib/types'

// SVG dashed trailer silhouettes for each angle
function TrailerGuide({ angle }: { angle: AngleKey }) {
  const d = { stroke: '#22c55e', strokeWidth: '2.5', strokeDasharray: '10 6', fill: 'none', opacity: '0.9' } as React.SVGProps<SVGRectElement>
  const s = (extra?: object) => ({ ...d, ...extra })

  switch (angle) {
    case 'front':
      return (
        <svg viewBox="0 0 200 220" className="w-full h-full">
          {/* Main front face */}
          <rect x="25" y="25" width="150" height="155" rx="4" {...s()} />
          {/* Top marker lights */}
          <rect x="31" y="31" width="24" height="12" rx="2" {...s()} />
          <rect x="145" y="31" width="24" height="12" rx="2" {...s()} />
          {/* Bottom marker lights */}
          <rect x="31" y="162" width="24" height="10" rx="2" {...s()} />
          <rect x="145" y="162" width="24" height="10" rx="2" {...s()} />
          {/* Landing gear */}
          <line x1="70" y1="180" x2="70" y2="212" {...s()} />
          <line x1="130" y1="180" x2="130" y2="212" {...s()} />
          <line x1="55" y1="212" x2="85" y2="212" {...s()} />
          <line x1="115" y1="212" x2="145" y2="212" {...s()} />
        </svg>
      )

    case 'rear':
      return (
        <svg viewBox="0 0 200 220" className="w-full h-full">
          {/* Main rear face */}
          <rect x="15" y="20" width="170" height="165" rx="4" {...s()} />
          {/* Door split center line */}
          <line x1="100" y1="20" x2="100" y2="185" {...s({ strokeDasharray: '6 4' })} />
          {/* Tail lights */}
          <rect x="20" y="26" width="22" height="35" rx="3" {...s()} />
          <rect x="158" y="26" width="22" height="35" rx="3" {...s()} />
          {/* Door handles */}
          <circle cx="83" cy="105" r="5" {...s({ strokeDasharray: '0', fill: 'rgba(34,197,94,0.3)' })} />
          <circle cx="117" cy="105" r="5" {...s({ strokeDasharray: '0', fill: 'rgba(34,197,94,0.3)' })} />
          {/* Latch bars */}
          <line x1="90" y1="70" x2="90" y2="155" {...s({ strokeDasharray: '5 4' })} />
          <line x1="110" y1="70" x2="110" y2="155" {...s({ strokeDasharray: '5 4' })} />
          {/* ICC bar */}
          <rect x="30" y="188" width="140" height="9" rx="3" {...s()} />
          {/* Bottom lights */}
          <rect x="20" y="165" width="22" height="12" rx="2" {...s()} />
          <rect x="158" y="165" width="22" height="12" rx="2" {...s()} />
        </svg>
      )

    case 'right':
    case 'left':
      return (
        <svg viewBox="0 0 320 150" className="w-full h-full">
          {/* Trailer body */}
          <rect x="8" y="15" width="304" height="95" rx="4" {...s()} />
          {/* Front corner light */}
          <rect x="8" y="20" width="10" height="22" rx="2" {...s()} />
          {/* Rear corner light */}
          <rect x="302" y="20" width="10" height="22" rx="2" {...s()} />
          {/* Tandem axle 1 wheels */}
          <ellipse cx="220" cy="120" rx="18" ry="12" {...s()} />
          <ellipse cx="220" cy="120" rx="10" ry="6" {...s({ strokeDasharray: '3 3' })} />
          {/* Tandem axle 2 wheels */}
          <ellipse cx="260" cy="120" rx="18" ry="12" {...s()} />
          <ellipse cx="260" cy="120" rx="10" ry="6" {...s({ strokeDasharray: '3 3' })} />
          {/* Axle */}
          <line x1="202" y1="120" x2="278" y2="120" {...s({ strokeDasharray: '4 3' })} />
        </svg>
      )

    case 'front-right':
      return (
        <svg viewBox="0 0 240 200" className="w-full h-full">
          {/* Front face (right perspective) */}
          <path d="M 100 20 L 220 20 L 220 170 L 100 170 Z" {...s()} />
          {/* Right side receding */}
          <path d="M 100 20 L 20 50 L 20 170 L 100 170" {...s()} />
          {/* Marker light */}
          <rect x="106" y="26" width="20" height="12" rx="2" {...s()} />
          {/* Glad hands (air lines) */}
          <circle cx="60" cy="100" r="8" {...s({ strokeDasharray: '3 3' })} />
          <circle cx="60" cy="120" r="8" {...s({ strokeDasharray: '3 3' })} />
          {/* Landing gear */}
          <line x1="130" y1="170" x2="130" y2="195" {...s()} />
          <line x1="160" y1="170" x2="160" y2="195" {...s()} />
          <line x1="118" y1="195" x2="142" y2="195" {...s()} />
          <line x1="148" y1="195" x2="172" y2="195" {...s()} />
        </svg>
      )

    case 'front-left':
      return (
        <svg viewBox="0 0 240 200" className="w-full h-full">
          {/* Front face (left perspective) */}
          <path d="M 20 20 L 140 20 L 140 170 L 20 170 Z" {...s()} />
          {/* Left side receding */}
          <path d="M 140 20 L 220 50 L 220 170 L 140 170" {...s()} />
          {/* Marker light */}
          <rect x="114" y="26" width="20" height="12" rx="2" {...s()} />
          {/* Air lines */}
          <circle cx="175" cy="100" r="8" {...s({ strokeDasharray: '3 3' })} />
          <circle cx="175" cy="120" r="8" {...s({ strokeDasharray: '3 3' })} />
          {/* Landing gear */}
          <line x1="70" y1="170" x2="70" y2="195" {...s()} />
          <line x1="100" y1="170" x2="100" y2="195" {...s()} />
          <line x1="58" y1="195" x2="82" y2="195" {...s()} />
          <line x1="88" y1="195" x2="112" y2="195" {...s()} />
        </svg>
      )

    case 'rear-right':
      return (
        <svg viewBox="0 0 240 200" className="w-full h-full">
          {/* Rear face (right perspective) */}
          <path d="M 20 20 L 140 20 L 140 170 L 20 170 Z" {...s()} />
          {/* Right side receding */}
          <path d="M 140 20 L 220 50 L 220 170 L 140 170" {...s()} />
          {/* Tail light on rear face */}
          <rect x="26" y="26" width="22" height="34" rx="3" {...s()} />
          {/* ICC bar */}
          <rect x="26" y="173" width="110" height="8" rx="2" {...s()} />
          {/* Rear axle wheel (right side) */}
          <ellipse cx="185" cy="162" rx="20" ry="13" {...s()} />
          <ellipse cx="185" cy="162" rx="11" ry="7" {...s({ strokeDasharray: '3 3' })} />
        </svg>
      )

    case 'rear-left':
      return (
        <svg viewBox="0 0 240 200" className="w-full h-full">
          {/* Rear face (left perspective) */}
          <path d="M 100 20 L 220 20 L 220 170 L 100 170 Z" {...s()} />
          {/* Left side receding */}
          <path d="M 100 20 L 20 50 L 20 170 L 100 170" {...s()} />
          {/* Tail light on rear face */}
          <rect x="192" y="26" width="22" height="34" rx="3" {...s()} />
          {/* ICC bar */}
          <rect x="104" y="173" width="110" height="8" rx="2" {...s()} />
          {/* Rear axle wheel (left side) */}
          <ellipse cx="55" cy="162" rx="20" ry="13" {...s()} />
          <ellipse cx="55" cy="162" rx="11" ry="7" {...s({ strokeDasharray: '3 3' })} />
        </svg>
      )

    default:
      return null
  }
}

export default function CameraPage() {
  const router = useRouter()
  const { photos, addPhoto, removePhoto, gps, setGPS } = useInspectionStore()
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

  // Auto-capture GPS on mount
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

    // Blur check
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const blurScore = computeBlurScore(imageData)
    const isBlurry = blurScore < 80
    if (isBlurry) {
      setBlurWarning(true)
      setTimeout(() => setBlurWarning(false), 2500)
    }

    // Stamp GPS + timestamp watermark at the bottom of the photo
    const now = new Date()
    const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    const gpsStr = gps ? `${gps.lat.toFixed(4)}, ${gps.lng.toFixed(4)}` : 'GPS unavailable'
    const watermark = `📍 ${gpsStr}   🕐 ${dateStr} ${timeStr}   ${currentAngleConfig.label}`

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
      angleLabel: currentAngleConfig.label,
      dataUrl,
      timestamp: now.toISOString(),
      gps: gps ?? undefined,
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
  }, [activeAngle, capturing, currentAngleConfig, currentIndex, addPhoto, gps])

  const goBack = () => {
    if (currentIndex > 0) setActiveAngle(INSPECTION_ANGLES[currentIndex - 1].key)
    else router.push('/inspection/start')
  }
  const goNext = () => {
    if (currentIndex < INSPECTION_ANGLES.length - 1) setActiveAngle(INSPECTION_ANGLES[currentIndex + 1].key)
  }

  return (
    <div className="flex flex-col h-screen bg-black">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-black border-b border-slate-800 safe-top">
        <button onClick={goBack} className="flex h-10 w-10 items-center justify-center text-slate-300">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div className="text-center">
          <p className="text-xs text-slate-400">{currentIndex + 1} of {INSPECTION_ANGLES.length}</p>
        </div>
        <button
          onClick={() => router.push('/inspection/checklist')}
          className="text-xs text-blue-400 font-medium px-2"
        >
          Skip
        </button>
      </div>

      {/* Camera area */}
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
                {/* Trailer shape guide overlay */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-8">
                  <div className="w-full" style={{ maxHeight: '55%', maxWidth: '85%' }}>
                    <TrailerGuide angle={activeAngle} />
                  </div>
                </div>

                {/* Angle label — big, at top */}
                <div className="absolute top-4 inset-x-0 flex justify-center pointer-events-none">
                  <div className="rounded-2xl bg-black/70 px-6 py-2">
                    <p className="text-2xl font-black text-white tracking-widest">{currentAngleConfig.label}</p>
                  </div>
                </div>

                {/* Instruction text */}
                <div className="absolute bottom-36 inset-x-4 rounded-xl bg-black/70 px-4 py-3 pointer-events-none">
                  <p className="text-sm text-white/95 text-center leading-relaxed font-medium">{currentAngleConfig.instruction}</p>
                </div>
              </>
            )}

            {/* Flash on capture */}
            {justCaptured && (
              <div className="absolute inset-0 bg-white/30 flex items-center justify-center pointer-events-none">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500">
                  <Check className="h-8 w-8 text-white" />
                </div>
              </div>
            )}

            {/* Blur warning */}
            {blurWarning && (
              <div className="absolute top-20 inset-x-4 rounded-xl bg-yellow-500/90 px-4 py-2 text-center pointer-events-none">
                <p className="text-sm font-semibold text-white">Image may be blurry — retake recommended</p>
              </div>
            )}

            {/* Preview thumbnail if already captured */}
            {currentPhoto && !justCaptured && (
              <div className="absolute top-16 right-4 w-20 h-14 rounded-lg overflow-hidden border-2 border-green-400 pointer-events-none">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={currentPhoto.dataUrl} alt="captured" className="w-full h-full object-cover" />
              </div>
            )}
          </>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />

      {/* Bottom controls */}
      <div className="bg-black px-4 py-3 space-y-3 safe-bottom">
        {/* Progress dots */}
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

        {/* Camera controls row */}
        <div className="flex items-center justify-between">
          {/* Retake */}
          <button
            onClick={() => removePhoto(activeAngle)}
            disabled={!currentPhoto}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 text-slate-400 disabled:opacity-30"
          >
            <RotateCcw className="h-5 w-5" />
          </button>

          {/* Shutter */}
          <button
            onClick={capturePhoto}
            disabled={capturing || !cameraReady}
            className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white/10 transition-transform active:scale-95 disabled:opacity-50"
          >
            <div className={cn('h-16 w-16 rounded-full bg-white transition-all', capturing && 'scale-90')} />
          </button>

          {/* Next angle */}
          <button
            onClick={goNext}
            disabled={currentIndex >= INSPECTION_ANGLES.length - 1}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 text-slate-400 disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {/* Proceed button */}
        {allCaptured ? (
          <button onClick={() => router.push('/inspection/checklist')} className="btn-primary w-full py-3">
            <Check className="h-4 w-4" /> All 8 photos captured — Next: Checklist
          </button>
        ) : (
          <button onClick={() => router.push('/inspection/checklist')} className="w-full rounded-xl border border-slate-700 py-3 text-sm font-medium text-slate-300">
            Skip to Checklist ({photos.length}/{INSPECTION_ANGLES.length} captured)
          </button>
        )}
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
