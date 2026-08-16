'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Check, RotateCcw, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'
import { INSPECTION_ANGLES } from '@/lib/angles'
import { cn } from '@/lib/utils'
import type { AngleKey, CapturedPhoto } from '@/lib/types'

const MULTI_PHOTO_ANGLES: AngleKey[] = ['damage', 'extras']
const REQUIRED_ANGLES = INSPECTION_ANGLES.filter(
  (a) => !MULTI_PHOTO_ANGLES.includes(a.key)
)

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
  const isMultiPhoto = MULTI_PHOTO_ANGLES.includes(activeAngle)
  const currentPhoto = isMultiPhoto ? undefined : photos.find((p) => p.angle === activeAngle)
  const multiPhotos = isMultiPhoto ? photos.filter((p) => p.angle === activeAngle) : []
  const allCaptured = REQUIRED_ANGLES.every((a) => photos.some((p) => p.angle === a.key))
  const requiredCaptured = photos.filter((p) => REQUIRED_ANGLES.some((a) => a.key === p.angle)).length

  const isTireAngle = activeAngle.startsWith('tire-')

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

    if (!isBlurry && !isMultiPhoto && currentIndex < INSPECTION_ANGLES.length - 1) {
      setTimeout(() => setActiveAngle(INSPECTION_ANGLES[currentIndex + 1].key), 800)
    }
  }, [activeAngle, capturing, currentAngleConfig, currentIndex, isMultiPhoto, addPhoto, gps])

  const handleRemove = () => {
    if (isMultiPhoto) {
      if (multiPhotos.length > 0) {
        const lastId = multiPhotos[multiPhotos.length - 1].id
        useInspectionStore.getState().photos.filter((p) => p.id !== lastId)
        // remove all then re-add all except last
        const keep = photos.filter((p) => p.angle !== activeAngle || p.id !== lastId)
        useInspectionStore.setState({ photos: keep })
      }
    } else {
      removePhoto(activeAngle)
    }
  }

  const goBack = () => {
    if (currentIndex > 0) setActiveAngle(INSPECTION_ANGLES[currentIndex - 1].key)
    else router.push('/inspection/start')
  }
  const goNext = () => {
    if (currentIndex < INSPECTION_ANGLES.length - 1) setActiveAngle(INSPECTION_ANGLES[currentIndex + 1].key)
  }

  const accentColor = activeAngle === 'extras'
    ? 'text-blue-400'
    : isTireAngle
    ? 'text-amber-400'
    : activeAngle === 'damage'
    ? 'text-orange-400'
    : 'text-white'

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
          onClick={() => router.push('/inspection/signature')}
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
                  <div className={`rounded-2xl px-6 py-2 ${
                    activeAngle === 'extras' ? 'bg-blue-600/80' :
                    isTireAngle ? 'bg-amber-600/80' :
                    activeAngle === 'damage' ? 'bg-orange-600/80' :
                    'bg-black/70'
                  }`}>
                    <p className={`text-2xl font-black tracking-widest ${accentColor}`}>
                      {currentAngleConfig.label}
                    </p>
                  </div>
                </div>

                {/* Instruction banner for multi-photo angles */}
                {isMultiPhoto && (
                  <div className={`absolute top-20 inset-x-8 rounded-xl px-4 py-2 text-center pointer-events-none ${
                    activeAngle === 'extras' ? 'bg-blue-500/80' : 'bg-orange-500/80'
                  }`}>
                    <p className="text-sm font-semibold text-white">
                      {activeAngle === 'extras'
                        ? 'Extra photos — capture any additional issues'
                        : 'Free photo — capture any damage or issues'}
                    </p>
                    {multiPhotos.length > 0 && (
                      <p className="text-xs text-white/80 mt-0.5">
                        {multiPhotos.length} photo{multiPhotos.length !== 1 ? 's' : ''} taken
                      </p>
                    )}
                  </div>
                )}

                {/* Tire instruction */}
                {isTireAngle && (
                  <div className="absolute bottom-32 inset-x-8 rounded-xl bg-black/60 px-4 py-2 text-center pointer-events-none">
                    <p className="text-xs text-amber-200">{currentAngleConfig.instruction}</p>
                  </div>
                )}
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

            {/* Thumbnail */}
            {isMultiPhoto ? (
              multiPhotos.length > 0 && !justCaptured && (
                <div className={`absolute top-16 right-4 w-20 h-14 rounded-lg overflow-hidden border-2 pointer-events-none ${
                  activeAngle === 'extras' ? 'border-blue-400' : 'border-orange-400'
                }`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={multiPhotos[multiPhotos.length - 1].dataUrl} alt="captured" className="w-full h-full object-cover" />
                  <div className={`absolute bottom-0 right-0 text-white text-xs font-bold px-1.5 py-0.5 rounded-tl ${
                    activeAngle === 'extras' ? 'bg-blue-500' : 'bg-orange-500'
                  }`}>
                    ×{multiPhotos.length}
                  </div>
                </div>
              )
            ) : (
              currentPhoto && !justCaptured && (
                <div className="absolute top-16 right-4 w-20 h-14 rounded-lg overflow-hidden border-2 border-green-400 pointer-events-none">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={currentPhoto.dataUrl} alt="captured" className="w-full h-full object-cover" />
                </div>
              )
            )}
          </>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />

      <div className="bg-black px-4 py-3 space-y-3 safe-bottom">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1 flex-wrap">
          {INSPECTION_ANGLES.map((a) => {
            const anglePhotos = photos.filter((p) => p.angle === a.key)
            const captured = anglePhotos.length > 0
            const active = a.key === activeAngle
            const isMulti = MULTI_PHOTO_ANGLES.includes(a.key)
            const isTire = a.key.startsWith('tire-')

            if (isMulti) {
              return (
                <button
                  key={a.key}
                  onClick={() => setActiveAngle(a.key)}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-bold transition-all border',
                    active
                      ? a.key === 'extras'
                        ? 'bg-blue-500 border-blue-500 text-white'
                        : 'bg-orange-500 border-orange-500 text-white'
                      : captured
                        ? a.key === 'extras'
                          ? 'bg-blue-400 border-blue-400 text-white'
                          : 'bg-orange-400 border-orange-400 text-white'
                        : 'bg-slate-700 border-slate-600 text-slate-400'
                  )}
                >
                  {anglePhotos.length > 0 ? `+${anglePhotos.length}` : a.key === 'extras' ? '+' : '⚠'}
                </button>
              )
            }

            return (
              <button
                key={a.key}
                onClick={() => setActiveAngle(a.key)}
                className={cn(
                  'rounded-full transition-all',
                  active
                    ? 'h-3 w-8 ' + (isTire ? 'bg-amber-400' : 'bg-white')
                    : captured
                    ? 'h-2.5 w-2.5 ' + (isTire ? 'bg-amber-500' : 'bg-green-400')
                    : 'h-2.5 w-2.5 bg-slate-600'
                )}
              />
            )
          })}
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={handleRemove}
            disabled={isMultiPhoto ? multiPhotos.length === 0 : !currentPhoto}
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
          <button onClick={() => router.push('/inspection/signature')} className="btn-primary w-full py-3">
            <Check className="h-4 w-4" /> All {REQUIRED_ANGLES.length} photos — Next: Sign &amp; Submit
          </button>
        ) : (
          <button onClick={() => router.push('/inspection/signature')} className="w-full rounded-xl border border-slate-700 py-3 text-sm font-medium text-slate-300">
            Skip to Sign &amp; Submit ({requiredCaptured}/{REQUIRED_ANGLES.length} captured)
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
