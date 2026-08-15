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

function InspectionStartContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const urlUnit    = searchParams.get('unit')    ?? ''
  const urlType    = (searchParams.get('type')   ?? 'PICKUP') as InspectionType
  const urlDriver  = searchParams.get('driver')  ?? ''
  const urlCompany = normalizeCompany(searchParams.get('company'))

  const store = useInspectionStore()

  const [driverName, setDriverName] = useState(urlDriver)
  const [unitNumber, setUnitNumber] = useState(urlUnit)
  const [inspType,   setInspType]   = useState<InspectionType>(urlType)

  const canBegin = driverName.trim().length > 0 && unitNumber.trim().length > 0

  const handleBegin = () => {
    if (!canBegin) return
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
      }
    )
    router.push('/inspection/camera')
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      {/* Header */}
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

          {/* Inspection type toggle */}
          <div className="flex rounded-xl overflow-hidden border border-white/20">
            <button
              onClick={() => setInspType('PICKUP')}
              className={`flex-1 py-5 text-lg font-black tracking-wide transition-colors ${
                inspType === 'PICKUP' ? 'bg-green-500 text-white' : 'bg-white/10 text-blue-200'
              }`}
            >
              ▲ PICKUP
            </button>
            <button
              onClick={() => setInspType('DROP_OFF')}
              className={`flex-1 py-5 text-lg font-black tracking-wide transition-colors ${
                inspType === 'DROP_OFF' ? 'bg-orange-500 text-white' : 'bg-white/10 text-blue-200'
              }`}
            >
              ▼ DROP-OFF
            </button>
          </div>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4">
        {/* Trailer unit number */}
        <div className="card">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Trailer Unit #</h3>
          <input
            type="text"
            placeholder="Enter trailer number"
            value={unitNumber}
            onChange={(e) => setUnitNumber(e.target.value)}
            className="input-field text-2xl font-black"
            autoCapitalize="characters"
            autoFocus={!urlUnit}
          />
        </div>

        {/* Driver name */}
        <div className="card">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Driver Name</h3>
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
          Begin {inspType === 'PICKUP' ? 'Pickup' : 'Drop-off'} Inspection →
        </button>
      </div>
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
