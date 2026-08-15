'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Check, RotateCcw, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'
import { INSPECTION_ANGLES } from '@/lib/angles'
import { cn } from '@/lib/utils'
import type { AngleKey, CapturedPhoto } from '@/lib/types'

// Solid white wireframe trailer outlines — transparent background, centered
function TrailerGuide({ angle }: { angle: AngleKey }) {
  const s: React.SVGAttributes<SVGElement> = {
    stroke: 'rgba(255,255,255,0.92)',
    strokeWidth: '2',
    fill: 'none',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }
  const f: React.SVGAttributes<SVGElement> = { ...s, stroke: 'rgba(255,255,255,0.38)' }

  switch (angle) {
    // ── FRONT ──────────────────────────────────────────────────────────────
    case 'front':
      return (
        <svg viewBox="0 0 200 248" className="w-full h-full">
          <rect x="30" y="18" width="140" height="162" {...s} />
          <line x1="30" y1="25" x2="170" y2="25" {...s} />
          <rect x="30" y="30" width="9" height="26" rx="1" {...s} />
          <rect x="161" y="30" width="9" height="26" rx="1" {...s} />
          {/* Left landing gear */}
          <line x1="64" y1="180" x2="64" y2="225" {...s} />
          <line x1="80" y1="180" x2="80" y2="220" {...s} />
          <line x1="50" y1="225" x2="78" y2="225" {...s} />
          <line x1="66" y1="220" x2="94" y2="220" {...s} />
          {/* Right landing gear */}
          <line x1="120" y1="180" x2="120" y2="220" {...s} />
          <line x1="136" y1="180" x2="136" y2="225" {...s} />
          <line x1="106" y1="220" x2="134" y2="220" {...s} />
          <line x1="122" y1="225" x2="150" y2="225" {...s} />
        </svg>
      )

    // ── REAR ───────────────────────────────────────────────────────────────
    case 'rear':
      return (
        <svg viewBox="0 0 200 248" className="w-full h-full">
          <rect x="30" y="18" width="140" height="162" {...s} />
          <line x1="30" y1="25" x2="170" y2="25" {...s} />
          {/* Tail lights */}
          <rect x="32" y="28" width="20" height="36" rx="2" {...s} />
          <rect x="148" y="28" width="20" height="36" rx="2" {...s} />
          {/* Door split */}
          <line x1="100" y1="65" x2="100" y2="178" {...f} />
          {/* Latch bars */}
          <line x1="87"  y1="88" x2="87"  y2="162" {...f} />
          <line x1="113" y1="88" x2="113" y2="162" {...f} />
          {/* Bottom lights */}
          <rect x="32"  y="152" width="20" height="14" rx="2" {...s} />
          <rect x="148" y="152" width="20" height="14" rx="2" {...s} />
          {/* ICC bar */}
          <rect x="38" y="182" width="124" height="8" rx="2" {...s} />
          {/* Rear wheels */}
          <ellipse cx="78"  cy="212" rx="18" ry="10" {...s} />
          <ellipse cx="122" cy="212" rx="18" ry="10" {...s} />
        </svg>
      )

    // ── RIGHT SIDE ─────────────────────────────────────────────────────────
    case 'right':
      return (
        <svg viewBox="0 0 370 185" className="w-full h-full">
          <rect x="12" y="28" width="346" height="102" {...s} />
          <line x1="12" y1="35" x2="358" y2="35" {...s} />
          <rect x="12"  y="38" width="9" height="26" rx="1" {...s} />
          <rect x="349" y="38" width="9" height="26" rx="1" {...s} />
          {/* Landing gear — front (left) */}
          <line x1="54" y1="130" x2="54" y2="162" {...s} />
          <line x1="70" y1="130" x2="70" y2="157" {...s} />
          <line x1="40" y1="162" x2="68" y2="162" {...s} />
          <line x1="57" y1="157" x2="84" y2="157" {...s} />
          {/* Tandem axle dual-wheels — rear (right) */}
          <ellipse cx="256" cy="156" rx="23" ry="17" {...s} />
          <ellipse cx="256" cy="156" rx="12" ry="9"  {...s} />
          <ellipse cx="304" cy="156" rx="23" ry="17" {...s} />
          <ellipse cx="304" cy="156" rx="12" ry="9"  {...s} />
          <line x1="233" y1="156" x2="327" y2="156" {...f} />
        </svg>
      )

    // ── LEFT SIDE ──────────────────────────────────────────────────────────
    case 'left':
      return (
        <svg viewBox="0 0 370 185" className="w-full h-full">
          <rect x="12" y="28" width="346" height="102" {...s} />
          <line x1="12" y1="35" x2="358" y2="35" {...s} />
          <rect x="12"  y="38" width="9" height="26" rx="1" {...s} />
          <rect x="349" y="38" width="9" height="26" rx="1" {...s} />
          {/* Tandem axle dual-wheels — rear (left) */}
          <ellipse cx="66"  cy="156" rx="23" ry="17" {...s} />
          <ellipse cx="66"  cy="156" rx="12" ry="9"  {...s} />
          <ellipse cx="114" cy="156" rx="23" ry="17" {...s} />
          <ellipse cx="114" cy="156" rx="12" ry="9"  {...s} />
          <line x1="43" y1="156" x2="137" y2="156" {...f} />
          {/* Landing gear — front (right) */}
          <line x1="300" y1="130" x2="300" y2="157" {...s} />
          <line x1="316" y1="130" x2="316" y2="162" {...s} />
          <line x1="286" y1="157" x2="313" y2="157" {...s} />
          <line x1="302" y1="162" x2="330" y2="162" {...s} />
        </svg>
      )

    // ── FRONT-RIGHT ────────────────────────────────────────────────────────
    case 'front-right':
      return (
        <svg viewBox="0 0 310 265" className="w-full h-full">
          {/* Top face */}
          <path d="M 14 78 L 38 44 L 290 54 L 266 88 Z" {...s} />
          {/* Front face (left, slight taper) */}
          <path d="M 14 78 L 38 44 L 38 218 L 14 238 Z" {...s} />
          {/* Right side face */}
          <path d="M 38 44 L 290 54 L 290 220 L 38 218 Z" {...s} />
          {/* Glad hands on front face */}
          <circle cx="26" cy="128" r="9" {...s} />
          <circle cx="26" cy="154" r="9" {...s} />
          <circle cx="26" cy="128" r="4" {...f} />
          <circle cx="26" cy="154" r="4" {...f} />
          {/* Landing gear below front face */}
          <line x1="20" y1="238" x2="20" y2="256" {...s} />
          <line x1="33" y1="234" x2="33" y2="250" {...s} />
          <line x1="9"  y1="256" x2="31" y2="256" {...s} />
          <line x1="22" y1="250" x2="45" y2="250" {...s} />
          {/* Tandem wheels on right side */}
          <ellipse cx="196" cy="228" rx="21" ry="15" {...s} />
          <ellipse cx="196" cy="228" rx="11" ry="8"  {...s} />
          <ellipse cx="244" cy="226" rx="21" ry="15" {...s} />
          <ellipse cx="244" cy="226" rx="11" ry="8"  {...s} />
          <line x1="175" y1="227" x2="265" y2="226" {...f} />
        </svg>
      )

    // ── REAR-RIGHT ─────────────────────────────────────────────────────────
    case 'rear-right':
      return (
        <svg viewBox="0 0 310 265" className="w-full h-full">
          {/* Top face */}
          <path d="M 20 88 L 20 54 L 272 44 L 296 78 L 296 88 L 20 88 Z" {...s} />
          {/* Right side face (left panel) */}
          <path d="M 20 88 L 272 88 L 272 222 L 20 230 Z" {...s} />
          {/* Rear face (right panel) */}
          <path d="M 272 88 L 296 78 L 296 222 L 272 222 Z" {...s} />
          {/* Tail lights on rear face */}
          <rect x="274" y="94" width="18" height="32" rx="2" {...s} />
          {/* Door split */}
          <line x1="284" y1="126" x2="284" y2="220" {...f} />
          {/* ICC bar */}
          <rect x="272" y="222" width="22" height="8" rx="2" {...s} />
          {/* Tandem wheels on right side */}
          <ellipse cx="84"  cy="228" rx="23" ry="16" {...s} />
          <ellipse cx="84"  cy="228" rx="12" ry="9"  {...s} />
          <ellipse cx="138" cy="226" rx="23" ry="16" {...s} />
          <ellipse cx="138" cy="226" rx="12" ry="9"  {...s} />
          <line x1="61" y1="227" x2="161" y2="226" {...f} />
        </svg>
      )

    // ── REAR-LEFT ──────────────────────────────────────────────────────────
    case 'rear-left':
      return (
        <svg viewBox="0 0 310 265" className="w-full h-full">
          {/* Top face */}
          <path d="M 14 78 L 38 44 L 290 54 L 290 88 L 38 88 L 14 78 Z" {...s} />
          {/* Rear face (left panel) */}
          <path d="M 14 78 L 38 44 L 38 222 L 14 222 Z" {...s} />
          {/* Left side face (right panel) */}
          <path d="M 38 44 L 290 54 L 290 230 L 38 222 Z" {...s} />
          {/* Tail lights on rear face */}
          <rect x="16" y="84" width="18" height="32" rx="2" {...s} />
          {/* Door split */}
          <line x1="26" y1="116" x2="26" y2="220" {...f} />
          {/* ICC bar */}
          <rect x="14" y="222" width="22" height="8" rx="2" {...s} />
          {/* Tandem wheels on left side */}
          <ellipse cx="172" cy="228" rx="23" ry="16" {...s} />
          <ellipse cx="172" cy="228" rx="12" ry="9"  {...s} />
          <ellipse cx="226" cy="226" rx="23" ry="16" {...s} />
          <ellipse cx="226" cy="226" rx="12" ry="9"  {...s} />
          <line x1="149" y1="227" x2="249" y2="226" {...f} />
        </svg>
      )

    // ── FRONT-LEFT ─────────────────────────────────────────────────────────
    case 'front-left':
      return (
        <svg viewBox="0 0 310 265" className="w-full h-full">
          {/* Top face */}
          <path d="M 20 54 L 272 44 L 296 78 L 44 88 L 20 78 Z" {...s} />
          {/* Left side face (left panel) */}
          <path d="M 20 54 L 272 44 L 272 220 L 20 230 Z" {...s} />
          {/* Front face (right panel, slight taper) */}
          <path d="M 272 44 L 296 78 L 296 238 L 272 220 Z" {...s} />
          {/* Glad hands on front face */}
          <circle cx="284" cy="128" r="9" {...s} />
          <circle cx="284" cy="154" r="9" {...s} />
          <circle cx="284" cy="128" r="4" {...f} />
          <circle cx="284" cy="154" r="4" {...f} />
          {/* Landing gear below front face */}
          <line x1="278" y1="238" x2="278" y2="256" {...s} />
          <line x1="291" y1="234" x2="291" y2="250" {...s} />
          <line x1="265" y1="256" x2="289" y2="256" {...s} />
          <line x1="279" y1="250" x2="302" y2="250" {...s} />
          {/* Tandem wheels on left side */}
          <ellipse cx="66"  cy="228" rx="21" ry="15" {...s} />
          <ellipse cx="66"  cy="228" rx="11" ry="8"  {...s} />
          <ellipse cx="114" cy="226" rx="21" ry="15" {...s} />
          <ellipse cx="114" cy="226" rx="11" ry="8"  {...s} />
          <line x1="45" y1="227" x2="135" y2="226" {...f} />
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
                {/* Angle label — top center */}
                <div className="absolute top-4 inset-x-0 flex justify-center pointer-events-none">
                  <div className="rounded-2xl bg-black/70 px-6 py-2">
                    <p className="text-2xl font-black text-white tracking-widest">{currentAngleConfig.label}</p>
                  </div>
                </div>

                {/* Trailer wireframe — centered, fills most of the camera viewport */}
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                  style={{ filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.35))' }}
                >
                  <div style={{ width: '82%', maxHeight: '62%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <TrailerGuide angle={activeAngle} />
                  </div>
                </div>
              </>
            )}

            {justCaptured && (
              <div className="absolute inset-0 bg-white/30 flex items-center justify-center pointer-events-none">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500">
                  <Check className="h-8 w-8 text-white" />
                </div>
              </div>
            )}

            {blurWarning && (
              <div className="absolute top-20 inset-x-4 rounded-xl bg-yellow-500/90 px-4 py-2 text-center pointer-events-none">
                <p className="text-sm font-semibold text-white">Image may be blurry — retake recommended</p>
              </div>
            )}

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

      <div className="bg-black px-4 py-3 space-y-3 safe-bottom">
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
            onClick={goNext}
            disabled={currentIndex >= INSPECTION_ANGLES.length - 1}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 text-slate-400 disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {allCaptured ? (
          <button onClick={() => router.push('/inspection/checklist')} className="btn-primary w-full py-3">
            <Check className="h-4 w-4" /> All 8 photos — Next: Checklist
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
