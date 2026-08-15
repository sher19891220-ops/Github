'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Check, RotateCcw, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'
import { INSPECTION_ANGLES } from '@/lib/angles'
import { cn } from '@/lib/utils'
import type { AngleKey, CapturedPhoto } from '@/lib/types'

// 3D dashed wireframe trailer silhouettes for each camera angle
function TrailerGuide({ angle }: { angle: AngleKey }) {
  const base: React.SVGAttributes<SVGElement> = {
    stroke: '#22c55e', strokeWidth: '2', strokeDasharray: '9 5', fill: 'none', opacity: '0.95',
  }
  const solid: React.SVGAttributes<SVGElement> = { ...base, strokeDasharray: '0' }
  const faint: React.SVGAttributes<SVGElement> = { ...base, opacity: '0.45', strokeDasharray: '5 6' }
  const filled = (fillColor: string): React.SVGAttributes<SVGElement> => ({
    ...base, fill: fillColor, strokeDasharray: '0',
  })

  switch (angle) {
    // ── FRONT — standing directly in front, full face + 3D depth ──
    case 'front':
      return (
        <svg viewBox="0 0 220 250" className="w-full h-full">
          {/* Top face (3D depth going right) */}
          <path d="M 30 42 L 52 22 L 212 22 L 190 42 Z" {...base} />
          {/* Right side face (narrow depth strip) */}
          <path d="M 190 42 L 212 22 L 212 202 L 190 202 Z" {...base} />
          {/* Main front face */}
          <rect x="30" y="42" width="160" height="160" rx="2" {...base} />
          {/* Top marker lights */}
          <rect x="36" y="48" width="26" height="13" rx="2" {...solid} />
          <rect x="158" y="48" width="26" height="13" rx="2" {...solid} />
          {/* Bottom marker lights */}
          <rect x="36" y="185" width="26" height="12" rx="2" {...solid} />
          <rect x="158" y="185" width="26" height="12" rx="2" {...solid} />
          {/* Landing gear — two legs with feet */}
          <line x1="75"  y1="202" x2="75"  y2="238" {...base} />
          <line x1="145" y1="202" x2="145" y2="238" {...base} />
          <line x1="60"  y1="238" x2="90"  y2="238" {...base} />
          <line x1="130" y1="238" x2="160" y2="238" {...base} />
          {/* Center top cap */}
          <rect x="88" y="20" width="44" height="8" rx="2" {...solid} />
        </svg>
      )

    // ── FRONT-RIGHT — standing at front-right corner ──
    case 'front-right':
      return (
        <svg viewBox="0 0 280 245" className="w-full h-full">
          {/* Top face parallelogram */}
          <path d="M 18 52 L 40 28 L 260 38 L 120 30 L 120 52 Z" {...faint} />
          <path d="M 18 52 L 120 30 L 260 38 L 260 48 L 120 42 L 18 65" {...base} />
          {/* Front face (left panel, slight perspective taper) */}
          <path d="M 18 52 L 120 42 L 120 205 L 18 215 Z" {...base} />
          {/* Right side face (right panel going into distance) */}
          <path d="M 120 42 L 260 48 L 260 200 L 120 205 Z" {...base} />
          {/* Marker light — front face top */}
          <rect x="23" y="55" width="22" height="12" rx="2" {...solid} />
          {/* Glad hands (air couplings) on front face */}
          <circle cx="65" cy="115" r="9" {...base} />
          <circle cx="65" cy="138" r="9" {...base} />
          <circle cx="65" cy="115" r="4" {...filled('rgba(34,197,94,0.25)')} />
          <circle cx="65" cy="138" r="4" {...filled('rgba(34,197,94,0.25)')} />
          {/* Landing gear (bottom of front face) */}
          <line x1="42"  y1="215" x2="42"  y2="242" {...base} />
          <line x1="85"  y1="210" x2="85"  y2="237" {...base} />
          <line x1="28"  y1="242" x2="56"  y2="242" {...base} />
          <line x1="71"  y1="237" x2="99"  y2="237" {...base} />
        </svg>
      )

    // ── RIGHT SIDE — center-right, full trailer length ──
    case 'right':
      return (
        <svg viewBox="0 0 340 175" className="w-full h-full">
          {/* Top face (thin strip above body) */}
          <path d="M 10 30 L 22 14 L 322 14 L 310 30 Z" {...base} />
          {/* Front face (narrow left strip) */}
          <path d="M 10 30 L 22 14 L 22 125 L 10 128 Z" {...base} />
          {/* Rear face (narrow right strip) */}
          <path d="M 310 30 L 322 14 L 322 125 L 310 128 Z" {...base} />
          {/* Main side body */}
          <rect x="10" y="30" width="300" height="98" rx="2" {...base} />
          {/* Roof ribs */}
          <line x1="80"  y1="30" x2="80"  y2="128" {...faint} />
          <line x1="160" y1="30" x2="160" y2="128" {...faint} />
          <line x1="240" y1="30" x2="240" y2="128" {...faint} />
          {/* Front corner light */}
          <rect x="10" y="35" width="10" height="25" rx="1" {...solid} />
          {/* Rear corner light */}
          <rect x="318" y="35" width="10" height="25" rx="1" {...solid} />
          {/* Landing gear (front area) */}
          <line x1="55"  y1="128" x2="55"  y2="155" {...base} />
          <line x1="90"  y1="128" x2="90"  y2="155" {...base} />
          <line x1="42"  y1="155" x2="68"  y2="155" {...base} />
          <line x1="77"  y1="155" x2="103" y2="155" {...base} />
          {/* Tandem axle 1 — dual wheels */}
          <ellipse cx="218" cy="148" rx="20" ry="14" {...base} />
          <ellipse cx="218" cy="148" rx="11" ry="8"  {...base} />
          {/* Tandem axle 2 */}
          <ellipse cx="262" cy="148" rx="20" ry="14" {...base} />
          <ellipse cx="262" cy="148" rx="11" ry="8"  {...base} />
          {/* Axle bar */}
          <line x1="198" y1="148" x2="282" y2="148" {...faint} />
        </svg>
      )

    // ── REAR-RIGHT — standing at rear-right corner ──
    case 'rear-right':
      return (
        <svg viewBox="0 0 280 245" className="w-full h-full">
          {/* Top face */}
          <path d="M 20 42 L 20 32 L 160 28 L 262 36 L 262 46 L 160 38 Z" {...base} />
          {/* Right side face (left panel, receding) */}
          <path d="M 20 42 L 160 38 L 160 205 L 20 210 Z" {...base} />
          {/* Rear face (right panel, flat) */}
          <path d="M 160 38 L 262 46 L 262 208 L 160 205 Z" {...base} />
          {/* Tail lights on rear face */}
          <rect x="168" y="50" width="22" height="38" rx="3" {...solid} />
          <rect x="234" y="50" width="22" height="38" rx="3" {...solid} />
          {/* Door split on rear face */}
          <line x1="211" y1="46" x2="211" y2="205" {...faint} />
          {/* ICC bar across rear face */}
          <rect x="166" y="208" width="92" height="10" rx="2" {...solid} />
          {/* Rear axle wheels on right side */}
          <ellipse cx="60"  cy="210" rx="22" ry="15" {...base} />
          <ellipse cx="60"  cy="210" rx="12" ry="8"  {...base} />
          <ellipse cx="108" cy="208" rx="22" ry="15" {...base} />
          <ellipse cx="108" cy="208" rx="12" ry="8"  {...base} />
          {/* Axle bar */}
          <line x1="38" y1="210" x2="130" y2="208" {...faint} />
          {/* Bottom marker lights on rear face */}
          <rect x="168" y="188" width="22" height="13" rx="2" {...solid} />
          <rect x="234" y="188" width="22" height="13" rx="2" {...solid} />
        </svg>
      )

    // ── REAR — standing directly behind ──
    case 'rear':
      return (
        <svg viewBox="0 0 220 250" className="w-full h-full">
          {/* Top face (3D depth going left) */}
          <path d="M 30 42 L 10 22 L 168 22 L 190 42 Z" {...base} />
          {/* Left side face (depth strip) */}
          <path d="M 30 42 L 10 22 L 10 202 L 30 202 Z" {...base} />
          {/* Main rear face */}
          <rect x="30" y="42" width="160" height="160" rx="2" {...base} />
          {/* Door center split */}
          <line x1="110" y1="42" x2="110" y2="202" {...faint} />
          {/* Tail lights */}
          <rect x="36" y="48" width="24" height="38" rx="3" {...solid} />
          <rect x="160" y="48" width="24" height="38" rx="3" {...solid} />
          {/* Door latch bars */}
          <line x1="94"  y1="75" x2="94"  y2="170" {...faint} />
          <line x1="126" y1="75" x2="126" y2="170" {...faint} />
          {/* Door handles */}
          <circle cx="97"  cy="122" r="5" {...filled('rgba(34,197,94,0.3)')} />
          <circle cx="123" cy="122" r="5" {...filled('rgba(34,197,94,0.3)')} />
          {/* Bottom lights */}
          <rect x="36"  y="185" width="24" height="13" rx="2" {...solid} />
          <rect x="160" y="185" width="24" height="13" rx="2" {...solid} />
          {/* ICC bar */}
          <rect x="36" y="205" width="148" height="10" rx="3" {...solid} />
          {/* Rear wheels visible below ICC bar */}
          <ellipse cx="82"  cy="235" rx="20" ry="10" {...base} />
          <ellipse cx="140" cy="235" rx="20" ry="10" {...base} />
        </svg>
      )

    // ── REAR-LEFT — standing at rear-left corner ──
    case 'rear-left':
      return (
        <svg viewBox="0 0 280 245" className="w-full h-full">
          {/* Top face */}
          <path d="M 18 36 L 18 46 L 120 38 L 262 42 L 262 32 L 120 28 Z" {...base} />
          {/* Left side face (right panel, receding into distance) */}
          <path d="M 120 38 L 262 42 L 262 210 L 120 205 Z" {...base} />
          {/* Rear face (left panel, flat) */}
          <path d="M 18 46 L 120 38 L 120 205 L 18 210 Z" {...base} />
          {/* Tail lights on rear face */}
          <rect x="24"  y="52" width="22" height="38" rx="3" {...solid} />
          <rect x="90"  y="52" width="22" height="38" rx="3" {...solid} />
          {/* Door split on rear face */}
          <line x1="69"  y1="46" x2="69"  y2="205" {...faint} />
          {/* ICC bar */}
          <rect x="22" y="208" width="92" height="10" rx="2" {...solid} />
          {/* Rear axle wheels on left side */}
          <ellipse cx="172" cy="210" rx="22" ry="15" {...base} />
          <ellipse cx="172" cy="210" rx="12" ry="8"  {...base} />
          <ellipse cx="220" cy="208" rx="22" ry="15" {...base} />
          <ellipse cx="220" cy="208" rx="12" ry="8"  {...base} />
          {/* Axle bar */}
          <line x1="150" y1="210" x2="242" y2="208" {...faint} />
          {/* Bottom marker lights */}
          <rect x="24" y="188" width="22" height="13" rx="2" {...solid} />
          <rect x="90" y="188" width="22" height="13" rx="2" {...solid} />
        </svg>
      )

    // ── LEFT SIDE — center-left, full trailer length (mirror of right) ──
    case 'left':
      return (
        <svg viewBox="0 0 340 175" className="w-full h-full">
          {/* Top face */}
          <path d="M 30 30 L 18 14 L 318 14 L 330 30 Z" {...base} />
          {/* Front face (narrow right strip — front is at RIGHT for left-side view) */}
          <path d="M 318 14 L 330 30 L 330 128 L 318 125 Z" {...base} />
          {/* Rear face (narrow left strip) */}
          <path d="M 10 30 L 18 14 L 18 125 L 10 128 Z" {...base} />
          {/* Main side body */}
          <rect x="10" y="30" width="320" height="98" rx="2" {...base} />
          {/* Roof ribs */}
          <line x1="100" y1="30" x2="100" y2="128" {...faint} />
          <line x1="180" y1="30" x2="180" y2="128" {...faint} />
          <line x1="260" y1="30" x2="260" y2="128" {...faint} />
          {/* Rear corner light (left side rear = right of image) */}
          <rect x="10" y="35" width="10" height="25" rx="1" {...solid} />
          {/* Front corner light (left side front = right of image) */}
          <rect x="318" y="35" width="10" height="25" rx="1" {...solid} />
          {/* Landing gear (at RIGHT side = front of trailer) */}
          <line x1="250" y1="128" x2="250" y2="155" {...base} />
          <line x1="285" y1="128" x2="285" y2="155" {...base} />
          <line x1="237" y1="155" x2="263" y2="155" {...base} />
          <line x1="272" y1="155" x2="298" y2="155" {...base} />
          {/* Tandem axle 1 */}
          <ellipse cx="78"  cy="148" rx="20" ry="14" {...base} />
          <ellipse cx="78"  cy="148" rx="11" ry="8"  {...base} />
          {/* Tandem axle 2 */}
          <ellipse cx="122" cy="148" rx="20" ry="14" {...base} />
          <ellipse cx="122" cy="148" rx="11" ry="8"  {...base} />
          {/* Axle bar */}
          <line x1="58" y1="148" x2="142" y2="148" {...faint} />
        </svg>
      )

    // ── FRONT-LEFT — standing at front-left corner ──
    case 'front-left':
      return (
        <svg viewBox="0 0 280 245" className="w-full h-full">
          {/* Top face */}
          <path d="M 20 38 L 20 48 L 160 42 L 262 52 L 262 42 L 160 30 Z" {...base} />
          {/* Left side face (left panel going into distance) */}
          <path d="M 20 38 L 160 30 L 160 205 L 20 215 Z" {...base} />
          {/* Front face (right panel, flat) */}
          <path d="M 160 30 L 262 42 L 262 208 L 160 205 Z" {...base} />
          {/* Marker light on front face top-right */}
          <rect x="230" y="48" width="22" height="12" rx="2" {...solid} />
          {/* Glad hands (air couplings) on front face */}
          <circle cx="210" cy="115" r="9" {...base} />
          <circle cx="210" cy="138" r="9" {...base} />
          <circle cx="210" cy="115" r="4" {...filled('rgba(34,197,94,0.25)')} />
          <circle cx="210" cy="138" r="4" {...filled('rgba(34,197,94,0.25)')} />
          {/* Landing gear (bottom of front face) */}
          <line x1="185" y1="205" x2="185" y2="233" {...base} />
          <line x1="228" y1="208" x2="228" y2="236" {...base} />
          <line x1="171" y1="233" x2="199" y2="233" {...base} />
          <line x1="214" y1="236" x2="242" y2="236" {...base} />
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
                {/* 3D wireframe trailer guide overlay */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-6">
                  <div className="w-full" style={{ maxHeight: '58%', maxWidth: '88%' }}>
                    <TrailerGuide angle={activeAngle} />
                  </div>
                </div>

                {/* Big angle label */}
                <div className="absolute top-4 inset-x-0 flex justify-center pointer-events-none">
                  <div className="rounded-2xl bg-black/75 px-6 py-2">
                    <p className="text-2xl font-black text-white tracking-widest">{currentAngleConfig.label}</p>
                  </div>
                </div>

                {/* Instruction */}
                <div className="absolute bottom-36 inset-x-4 rounded-xl bg-black/70 px-4 py-3 pointer-events-none">
                  <p className="text-sm text-white/95 text-center leading-relaxed font-medium">{currentAngleConfig.instruction}</p>
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
