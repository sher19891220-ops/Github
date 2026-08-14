'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { MapPin, Loader2, AlertCircle, Gauge, Droplets, Truck } from 'lucide-react'
import { TopBar } from '@/components/ui/TopBar'
import { FuelSlider } from '@/components/ui/FuelSlider'
import { InspectionTypeBadge } from '@/components/ui/Badge'
import { useInspectionStore } from '@/store/inspectionStore'
import { haversineDistance } from '@/lib/utils'
import type { InspectionType, Company } from '@/lib/types'

const ZONE_LAT = 29.7604
const ZONE_LNG = -95.3698

const COMPANIES: Company[] = ['Zone LLC', 'Xtrack LLC', 'AFG Transportco']

function normalizeCompany(raw: string | null): Company {
  if (!raw) return 'Zone LLC'
  const map: Record<string, Company> = {
    'zone': 'Zone LLC', 'zone llc': 'Zone LLC',
    'xtrack': 'Xtrack LLC', 'xtrack llc': 'Xtrack LLC',
    'afg': 'AFG Transportco', 'afg transportco': 'AFG Transportco',
  }
  return map[raw.toLowerCase()] ?? (COMPANIES.includes(raw as Company) ? (raw as Company) : 'Zone LLC')
}

function InspectionStartContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const urlUnit    = searchParams.get('unit')    ?? ''
  const urlType    = (searchParams.get('type')   ?? 'PICKUP') as InspectionType
  const urlDriver  = searchParams.get('driver')  ?? ''
  const urlCompany = normalizeCompany(searchParams.get('company'))

  const store = useInspectionStore()

  const [driverName, setDriverName] = useState(urlDriver)
  const [driverCDL,  setDriverCDL]  = useState('')
  const [unitNumber, setUnitNumber] = useState(urlUnit)
  const [company,    setCompany]    = useState<Company>(urlCompany)
  const [inspType,   setInspType]   = useState<InspectionType>(urlType)

  const hasSession = !!(store.inspectionType && store.vehicle && store.driver)
  const [phase, setPhase] = useState<'info' | 'measures'>(hasSession ? 'measures' : 'info')

  const [gpsLoading,      setGpsLoading]      = useState(false)
  const [gpsError,        setGpsError]        = useState<string | null>(null)
  const [distanceWarning, setDistanceWarning] = useState<string | null>(null)

  const captureGPS = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsError('Geolocation not supported on this device')
      return
    }
    setGpsLoading(true)
    setGpsError(null)
    setDistanceWarning(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords
        store.setGPS({ lat, lng, accuracy, timestamp: new Date().toISOString(), address: `${lat.toFixed(4)}, ${lng.toFixed(4)}` })
        setGpsLoading(false)
        const dist = haversineDistance(lat, lng, ZONE_LAT, ZONE_LNG)
        if (dist > 50) setDistanceWarning(`${Math.round(dist)} miles from base — verify location is correct.`)
      },
      (err) => { setGpsError(err.message || 'Could not get location'); setGpsLoading(false) },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    )
  }, [store])

  useEffect(() => {
    if (phase === 'measures') captureGPS()
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleBegin = () => {
    if (!driverName.trim() || !unitNumber.trim()) return
    const initials = driverName.trim().split(' ').map((n) => n[0] ?? '').join('').slice(0, 2).toUpperCase()
    store.initSession(
      inspType,
      { id: `drv-${Date.now()}`, name: driverName.trim(), licenseNumber: driverCDL.trim() || 'N/A', company, avatarInitials: initials, phone: '' },
      { id: `veh-${Date.now()}`, unitNumber: unitNumber.trim(), plateNumber: '', make: '', model: '', year: new Date().getFullYear(), company }
    )
    setPhase('measures')
  }

  if (phase === 'info') {
    return (
      <div className="min-h-screen bg-slate-50 pb-10">
        <div className="bg-gradient-to-br from-blue-700 to-blue-900 text-white safe-top">
          <div className="px-4 pt-4 pb-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20">
                <Truck className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-lg font-bold leading-tight">PTI Inspection</h1>
                <p className="text-xs text-blue-200">No login required</p>
              </div>
            </div>
            <div className="flex rounded-xl overflow-hidden border border-white/20">
              <button
                onClick={() => setInspType('PICKUP')}
                className={`flex-1 py-3 text-sm font-bold transition-colors ${
                  inspType === 'PICKUP' ? 'bg-green-500 text-white' : 'bg-white/10 text-blue-200'
                }`}
              >
                ▲ PICKUP
              </button>
              <button
                onClick={() => setInspType('DROP_OFF')}
                className={`flex-1 py-3 text-sm font-bold transition-colors ${
                  inspType === 'DROP_OFF' ? 'bg-orange-500 text-white' : 'bg-white/10 text-blue-200'
                }`}
              >
                ▼ DROP-OFF
              </button>
            </div>
          </div>
        </div>

        <div className="px-4 py-4 space-y-4">
          <div className="card space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Driver Info</h3>
            <div>
              <label className="text-xs text-slate-500 mb-1 block">Full Name *</label>
              <input type="text" placeholder="Your full name" value={driverName} onChange={(e) => setDriverName(e.target.value)} className="input-field" autoComplete="name" autoFocus={!urlDriver} />
            </div>
            <div>
              <label className="text-xs text-slate-500 mb-1 block">CDL # (optional)</label>
              <input type="text" placeholder="Driver license number" value={driverCDL} onChange={(e) => setDriverCDL(e.target.value)} className="input-field" />
            </div>
          </div>

          <div className="card">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Vehicle Unit #</h3>
            <input type="text" placeholder="e.g. ZN-401" value={unitNumber} onChange={(e) => setUnitNumber(e.target.value)} className="input-field text-xl font-bold" autoCapitalize="characters" />
          </div>

          <div className="card">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Company</h3>
            <div className="flex flex-col gap-2">
              {COMPANIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setCompany(c)}
                  className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${
                    company === c ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-700'
                  }`}
                >
                  {c}
                  {company === c && <span className="text-blue-500">✓</span>}
                </button>
              ))}
            </div>
          </div>

          <button
            disabled={!driverName.trim() || !unitNumber.trim()}
            onClick={handleBegin}
            className="btn-primary w-full py-4 text-base disabled:opacity-40"
          >
            Begin {inspType === 'PICKUP' ? 'Pickup' : 'Drop-off'} Inspection →
          </button>
        </div>
      </div>
    )
  }

  const displayUnit   = store.vehicle?.unitNumber || unitNumber
  const displayDriver = store.driver?.name        || driverName
  const displayType   = store.inspectionType      || inspType

  return (
    <div className="min-h-screen bg-slate-50 pb-8">
      <TopBar
        title={`${displayType === 'PICKUP' ? 'Pickup' : 'Drop-off'} Inspection`}
        subtitle={`Unit ${displayUnit} · ${displayDriver}`}
        showBack
        backHref="/"
        rightAction={<InspectionTypeBadge type={displayType} />}
      />
      <div className="px-4 py-4 space-y-4">
        <div className="card">
          <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
            <Gauge className="h-4 w-4" />
            Odometer Reading
          </label>
          <div className="relative">
            <input
              type="number" inputMode="numeric" placeholder="Enter current mileage"
              value={store.odometer || ''} onChange={(e) => store.setOdometer(Number(e.target.value))}
              className="input-field pr-14 text-xl font-bold"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-slate-400 font-medium">miles</span>
          </div>
          {store.odometer === 0 && <p className="mt-1.5 text-xs text-red-500">* Odometer reading required</p>}
        </div>

        <div className="card">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
            <Droplets className="h-4 w-4" />
            Fuel Level
          </div>
          <FuelSlider value={store.fuelLevel} onChange={store.setFuelLevel} />
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <MapPin className="h-4 w-4" />
              GPS Location
            </label>
            <button onClick={captureGPS} disabled={gpsLoading} className="text-xs text-blue-600 font-medium disabled:opacity-50">
              {gpsLoading ? 'Locating…' : 'Refresh'}
            </button>
          </div>
          {gpsLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Getting GPS location…
            </div>
          )}
          {store.gps && !gpsLoading && (
            <div className="rounded-xl bg-green-50 border border-green-200 px-3 py-2.5">
              <p className="text-sm font-semibold text-green-800">📍 Location captured</p>
              <p className="text-xs text-green-600 mt-0.5">{store.gps.lat.toFixed(5)}, {store.gps.lng.toFixed(5)} · ±{Math.round(store.gps.accuracy)}m</p>
            </div>
          )}
          {gpsError && (
            <div className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2.5">
              <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
              <p className="text-xs text-red-600">{gpsError}</p>
            </div>
          )}
          {distanceWarning && (
            <div className="mt-2 flex items-start gap-2 rounded-xl bg-yellow-50 border border-yellow-200 px-3 py-2.5">
              <AlertCircle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-yellow-700">{distanceWarning}</p>
            </div>
          )}
        </div>

        <button
          disabled={store.odometer === 0}
          onClick={() => router.push('/inspection/camera')}
          className="btn-primary w-full py-4 text-base disabled:opacity-40"
        >
          Next: Camera Walkaround →
        </button>
      </div>
    </div>
  )
}

export default function InspectionStartPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-blue-600" /></div>}>
      <InspectionStartContent />
    </Suspense>
  )
}
