'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, Loader2, AlertCircle, Gauge, Droplets } from 'lucide-react'
import { TopBar } from '@/components/ui/TopBar'
import { FuelSlider } from '@/components/ui/FuelSlider'
import { InspectionTypeBadge } from '@/components/ui/Badge'
import { useInspectionStore } from '@/store/inspectionStore'
import { haversineDistance } from '@/lib/utils'

const ZONE_LAT = 29.7604
const ZONE_LNG = -95.3698

export default function InspectionStartPage() {
  const router = useRouter()
  const {
    inspectionType, vehicle, driver,
    odometer, fuelLevel,
    setOdometer, setFuelLevel, setGPS, gps
  } = useInspectionStore()

  const [gpsLoading, setGpsLoading] = useState(false)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [distanceWarning, setDistanceWarning] = useState<string | null>(null)

  // All hooks must be called before any early return
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
        const gpsData = {
          lat, lng, accuracy,
          timestamp: new Date().toISOString(),
          address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
        }
        setGPS(gpsData)
        setGpsLoading(false)
        const dist = haversineDistance(lat, lng, ZONE_LAT, ZONE_LNG)
        if (dist > 50) {
          setDistanceWarning(`Location is ${Math.round(dist)} miles from base — verify this is correct.`)
        }
      },
      (err) => {
        setGpsError(err.message || 'Could not get location')
        setGpsLoading(false)
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    )
  }, [setGPS])

  useEffect(() => { captureGPS() }, [captureGPS])

  // Guard after all hooks
  if (!inspectionType || !vehicle || !driver) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-500">No active session. <a href="/" className="text-blue-600 underline">Go home</a></p>
      </div>
    )
  }

  const canProceed = odometer > 0

  return (
    <div className="min-h-screen bg-slate-50 pb-8">
      <TopBar
        title={`${inspectionType === 'PICKUP' ? 'Pickup' : 'Drop-off'} Inspection`}
        subtitle={`Unit ${vehicle.unitNumber} · ${driver.name}`}
        showBack
        backHref="/"
        rightAction={<InspectionTypeBadge type={inspectionType} />}
      />

      <div className="px-4 py-4 space-y-4">
        {/* Vehicle Info */}
        <div className="card">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Vehicle</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-slate-500">Unit #</p>
              <p className="text-base font-bold text-slate-900">{vehicle.unitNumber}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Plate</p>
              <p className="text-base font-bold text-slate-900">{vehicle.plateNumber}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Make / Model</p>
              <p className="text-sm font-semibold text-slate-700">{vehicle.year} {vehicle.make} {vehicle.model}</p>
            </div>
            {vehicle.trailerNumber && (
              <div>
                <p className="text-xs text-slate-500">Trailer #</p>
                <p className="text-sm font-semibold text-slate-700">{vehicle.trailerNumber}</p>
              </div>
            )}
          </div>
        </div>

        {/* Odometer */}
        <div className="card">
          <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
            <Gauge className="h-4 w-4" />
            Odometer Reading
          </label>
          <div className="relative">
            <input
              type="number"
              inputMode="numeric"
              placeholder="Enter current mileage"
              value={odometer || ''}
              onChange={(e) => setOdometer(Number(e.target.value))}
              className="input-field pr-14 text-xl font-bold"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-slate-400 font-medium">miles</span>
          </div>
          {odometer === 0 && (
            <p className="mt-1.5 text-xs text-red-500">* Odometer reading required</p>
          )}
        </div>

        {/* Fuel Level */}
        <div className="card">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
            <Droplets className="h-4 w-4" />
            Fuel Level
          </div>
          <FuelSlider value={fuelLevel} onChange={setFuelLevel} />
        </div>

        {/* GPS Location */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <MapPin className="h-4 w-4" />
              GPS Location
            </label>
            <button
              onClick={captureGPS}
              disabled={gpsLoading}
              className="text-xs text-blue-600 font-medium disabled:opacity-50"
            >
              {gpsLoading ? 'Locating…' : 'Refresh'}
            </button>
          </div>

          {gpsLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Getting GPS location…
            </div>
          )}

          {gps && !gpsLoading && (
            <div className="rounded-xl bg-green-50 border border-green-200 px-3 py-2.5">
              <p className="text-sm font-semibold text-green-800">📍 Location captured</p>
              <p className="text-xs text-green-600 mt-0.5">
                {gps.lat.toFixed(5)}, {gps.lng.toFixed(5)} · ±{Math.round(gps.accuracy)}m
              </p>
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

        {/* Next Button */}
        <button
          disabled={!canProceed}
          onClick={() => router.push('/inspection/camera')}
          className="btn-primary w-full py-4 text-base"
        >
          Next: Camera Walkaround →
        </button>
      </div>
    </div>
  )
}
