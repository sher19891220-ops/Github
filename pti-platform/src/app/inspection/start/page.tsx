'use client'
import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2, Truck } from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'
import type { InspectionType, Company } from '@/lib/types'

const COMPANIES: Company[] = ['Zone LLC', 'Xtrack LLC', 'AFG Transportco']

function normalizeCompany(raw: string | null): Company {
  if (!raw) return 'Zone LLC'
  const map: Record<string, Company> = {
    zone: 'Zone LLC', 'zone llc': 'Zone LLC',
    xtrack: 'Xtrack LLC', 'xtrack llc': 'Xtrack LLC',
    afg: 'AFG Transportco', 'afg transportco': 'AFG Transportco',
  }
  return map[raw.toLowerCase()] ?? (COMPANIES.includes(raw as Company) ? (raw as Company) : 'Zone LLC')
}

type VehicleKind = 'TRUCK' | 'TRAILER'
type Movement = 'PICKUP' | 'DROPOFF'
type TruckMode = 'DAILY' | 'FULL'
type TrailerType = 'DRY_VAN' | 'REEFER' | 'FLATBED' | 'STEPDECK'
type Step = 'vehicle' | 'movement' | 'mode' | 'form'

const TRAILER_TYPES: { key: TrailerType; label: string; hint: string }[] = [
  { key: 'DRY_VAN',  label: 'Dry Van',  hint: 'Standard enclosed box' },
  { key: 'REEFER',   label: 'Reefer',   hint: 'Temperature-controlled' },
  { key: 'FLATBED',  label: 'Flatbed',  hint: 'Open deck, tarps & chains' },
  { key: 'STEPDECK', label: 'Stepdeck', hint: 'Two-level open deck' },
]

function buildInspectionType(
  vehicleKind: VehicleKind,
  movement: Movement,
  truckMode: TruckMode | null,
  trailerType: TrailerType | null
): InspectionType {
  if (vehicleKind === 'TRUCK') {
    return `TRUCK_${movement}_${truckMode ?? 'DAILY'}` as InspectionType
  }
  return `TRAILER_${movement}_${trailerType ?? 'DRY_VAN'}` as InspectionType
}

function InspectionStartContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const urlUnit    = searchParams.get('unit')    ?? ''
  const urlDriver  = searchParams.get('driver')  ?? ''
  const urlCompany = normalizeCompany(searchParams.get('company'))
  const urlGroup   = parseInt(searchParams.get('group') ?? '', 10) || null

  const store = useInspectionStore()

  const [step, setStep] = useState<Step>('vehicle')
  const [vehicleKind, setVehicleKind]   = useState<VehicleKind | null>(null)
  const [movement, setMovement]         = useState<Movement | null>(null)
  const [truckMode, setTruckMode]       = useState<TruckMode | null>(null)
  const [trailerType, setTrailerType]   = useState<TrailerType | null>(null)

  const [driverName, setDriverName] = useState(urlDriver)
  const [unitNumber, setUnitNumber] = useState(urlUnit)

  const canBegin = driverName.trim().length > 0 && unitNumber.trim().length > 0

  const chooseVehicle = (v: VehicleKind) => { setVehicleKind(v); setStep('movement') }
  const chooseMovement = (m: Movement) => { setMovement(m); setStep('mode') }
  const chooseTruckMode = (mode: TruckMode) => { setTruckMode(mode); setStep('form') }
  const chooseTrailerType = (t: TrailerType) => { setTrailerType(t); setStep('form') }

  const goBack = () => {
    if (step === 'form')     setStep('mode')
    else if (step === 'mode')     setStep('movement')
    else if (step === 'movement') setStep('vehicle')
  }

  const handleBegin = () => {
    if (!canBegin || !vehicleKind || !movement) return
    const inspType = buildInspectionType(vehicleKind, movement, truckMode, trailerType)
    const initials = driverName.trim().split(' ').map((n) => n[0] ?? '').join('').slice(0, 2).toUpperCase()
    store.initSession(
      inspType,
      {
        id: `drv-${Date.now()}`,
        name: driverName.trim(),
        licenseNumber: 'N/A',
        company: urlCompany,
        avatarInitials: initials,
        phone: '',
      },
      {
        id: `veh-${Date.now()}`,
        unitNumber: unitNumber.trim(),
        plateNumber: '',
        make: '',
        model: '',
        year: new Date().getFullYear(),
        company: urlCompany,
      },
      urlGroup,
    )
    router.push('/inspection/camera')
  }

  const movementLabel = movement === 'PICKUP' ? 'Pickup' : 'Drop-off'
  const vehicleLabel = vehicleKind === 'TRUCK' ? 'Truck' : 'Trailer'

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <div className="bg-gradient-to-br from-blue-700 to-blue-900 text-white safe-top">
        <div className="px-4 pt-4 pb-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20">
              <Truck className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <h1 className="text-lg font-bold leading-tight">PTI Inspection</h1>
              <p className="text-xs text-blue-200">
                {step === 'vehicle' && 'No login required'}
                {step !== 'vehicle' && `${vehicleLabel}${movement ? ` · ${movementLabel}` : ''}`}
              </p>
            </div>
            {step !== 'vehicle' && (
              <button onClick={goBack} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold">
                ← Back
              </button>
            )}
          </div>

          {/* Step 1: Truck vs Trailer */}
          {step === 'vehicle' && (
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => chooseVehicle('TRUCK')}
                className="rounded-2xl border border-white/20 bg-white/10 py-8 text-lg font-black tracking-wide transition-colors hover:bg-white/20"
              >
                🚛<br />TRUCK
              </button>
              <button
                onClick={() => chooseVehicle('TRAILER')}
                className="rounded-2xl border border-white/20 bg-white/10 py-8 text-lg font-black tracking-wide transition-colors hover:bg-white/20"
              >
                🚚<br />TRAILER
              </button>
            </div>
          )}

          {/* Step 2: Pickup vs Drop-off */}
          {step === 'movement' && (
            <div className="flex rounded-xl overflow-hidden border border-white/20">
              <button
                onClick={() => chooseMovement('PICKUP')}
                className="flex-1 bg-white/10 py-6 text-lg font-black tracking-wide text-blue-200 transition-colors hover:bg-green-500 hover:text-white"
              >
                ▲ PICKUP
              </button>
              <button
                onClick={() => chooseMovement('DROPOFF')}
                className="flex-1 bg-white/10 py-6 text-lg font-black tracking-wide text-blue-200 transition-colors hover:bg-orange-500 hover:text-white"
              >
                ▼ DROP-OFF
              </button>
            </div>
          )}

          {/* Step 3a: Truck — Daily vs Full */}
          {step === 'mode' && vehicleKind === 'TRUCK' && (
            <div className="flex rounded-xl overflow-hidden border border-white/20">
              <button
                onClick={() => chooseTruckMode('DAILY')}
                className="flex-1 bg-white/10 py-6 text-base font-black leading-tight tracking-wide text-blue-200 transition-colors hover:bg-blue-500 hover:text-white"
              >
                ⚡ DAILY PTI
                <span className="mt-0.5 block text-[10px] font-semibold opacity-70">Everyday safety check</span>
              </button>
              <button
                onClick={() => chooseTruckMode('FULL')}
                className="flex-1 bg-white/10 py-6 text-base font-black leading-tight tracking-wide text-blue-200 transition-colors hover:bg-blue-500 hover:text-white"
              >
                📋 FULL INSPECTION
                <span className="mt-0.5 block text-[10px] font-semibold opacity-70">Documents + interior + exterior</span>
              </button>
            </div>
          )}

          {/* Step 3b: Trailer type */}
          {step === 'mode' && vehicleKind === 'TRAILER' && (
            <div className="grid grid-cols-2 gap-2.5">
              {TRAILER_TYPES.map((t) => (
                <button
                  key={t.key}
                  onClick={() => chooseTrailerType(t.key)}
                  className="rounded-xl border border-white/20 bg-white/10 px-3 py-4 text-left transition-colors hover:bg-white/20"
                >
                  <span className="block text-base font-black tracking-wide">{t.label}</span>
                  <span className="mt-0.5 block text-[11px] text-blue-200">{t.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Step 4: unit + driver form */}
      {step === 'form' && (
        <div className="space-y-4 px-4 py-4">
          <div className="card">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {vehicleKind === 'TRUCK' ? 'Truck Unit #' : 'Trailer Unit #'}
            </h3>
            <input
              type="text"
              placeholder={vehicleKind === 'TRUCK' ? 'Enter truck number' : 'Enter trailer number'}
              value={unitNumber}
              onChange={(e) => setUnitNumber(e.target.value)}
              className="input-field text-2xl font-black"
              autoCapitalize="characters"
              autoFocus={!urlUnit}
            />
          </div>

          <div className="card">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Driver Name</h3>
            <input
              type="text"
              placeholder="Your full name"
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
              className="input-field text-xl"
              autoComplete="name"
            />
          </div>

          <button
            disabled={!canBegin}
            onClick={handleBegin}
            className="btn-primary w-full py-5 text-lg font-black disabled:opacity-40"
          >
            Begin {vehicleKind === 'TRUCK'
              ? (truckMode === 'FULL' ? 'Full Truck' : 'Daily PTI')
              : (TRAILER_TYPES.find((t) => t.key === trailerType)?.label ?? 'Trailer')
            } {movementLabel} →
          </button>
        </div>
      )}
    </div>
  )
}

export default function InspectionStartPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      }
    >
      <InspectionStartContent />
    </Suspense>
  )
}
