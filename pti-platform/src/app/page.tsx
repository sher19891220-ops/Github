'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Truck, Shield, Wifi, WifiOff } from 'lucide-react'
import { MOCK_DRIVERS, MOCK_VEHICLES, MOCK_INSPECTIONS } from '@/lib/mockData'
import { InspectionTypeBadge, StatusBadge } from '@/components/ui/Badge'
import { timeAgo } from '@/lib/utils'
import type { InspectionType } from '@/lib/types'
import { useInspectionStore } from '@/store/inspectionStore'

export default function HomePage() {
  const router = useRouter()
  const { initSession } = useInspectionStore()
  const [isOnline, setIsOnline] = useState(true)
  const [driver] = useState(MOCK_DRIVERS[0])

  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    setIsOnline(navigator.onLine)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const startInspection = (type: InspectionType) => {
    initSession(type, MOCK_DRIVERS[0], MOCK_VEHICLES[0])
    router.push('/inspection/start')
  }

  const recentInspections = MOCK_INSPECTIONS.slice(0, 3)

  return (
    <main className="min-h-screen bg-slate-50 pb-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-blue-700 to-blue-900 text-white safe-top">
        <div className="px-4 pt-4 pb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20">
                <Truck className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs text-blue-200 font-medium">PTI Platform</p>
                <p className="text-xs text-blue-300">{driver.company}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isOnline
                ? <Wifi className="h-4 w-4 text-green-300" />
                : <WifiOff className="h-4 w-4 text-yellow-300" />}
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-xs font-bold">
                {driver.avatarInitials}
              </div>
            </div>
          </div>

          <div>
            <p className="text-blue-200 text-sm">Good {getGreeting()},</p>
            <h1 className="text-2xl font-bold mt-0.5">{driver.name.split(' ')[0]}</h1>
            <p className="text-blue-200 text-xs mt-1">CDL: {driver.licenseNumber}</p>
          </div>

          <div className="mt-4 flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2">
            <Shield className="h-4 w-4 text-green-300 flex-shrink-0" />
            <p className="text-xs text-blue-100">FMCSA compliant · Records stored 12 months</p>
          </div>
        </div>
      </div>

      {/* Start Inspection Buttons */}
      <div className="px-4 -mt-1">
        <div className="grid grid-cols-2 gap-3 mt-4">
          <button
            onClick={() => startInspection('PICKUP')}
            className="flex flex-col items-center gap-2 rounded-2xl bg-green-600 p-5 text-white shadow-lg shadow-green-600/30 transition-transform active:scale-95"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/20">
              <span className="text-2xl">▲</span>
            </div>
            <span className="text-sm font-bold">Start Pickup</span>
            <span className="text-xs text-green-200">Pre-trip inspection</span>
          </button>

          <button
            onClick={() => startInspection('DROP_OFF')}
            className="flex flex-col items-center gap-2 rounded-2xl bg-orange-500 p-5 text-white shadow-lg shadow-orange-500/30 transition-transform active:scale-95"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/20">
              <span className="text-2xl">▼</span>
            </div>
            <span className="text-sm font-bold">Start Drop-off</span>
            <span className="text-xs text-orange-200">Post-trip inspection</span>
          </button>
        </div>
      </div>

      {/* Offline Banner */}
      {!isOnline && (
        <div className="mx-4 mt-4 flex items-center gap-3 rounded-xl bg-yellow-50 border border-yellow-200 px-4 py-3">
          <WifiOff className="h-4 w-4 text-yellow-600 flex-shrink-0" />
          <p className="text-xs text-yellow-700 font-medium">Offline — inspection saved locally and will sync when connected</p>
        </div>
      )}

      {/* Recent Inspections */}
      <div className="mt-6 px-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-900">Recent Inspections</h2>
          <button
            onClick={() => router.push('/history')}
            className="text-xs text-blue-600 font-medium"
          >
            See all
          </button>
        </div>

        <div className="space-y-2">
          {recentInspections.map((ins) => (
            <div key={ins.id} className="card flex items-center gap-3">
              <div
                className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-white text-sm font-bold ${
                  ins.type === 'PICKUP' ? 'bg-green-500' : 'bg-orange-500'
                }`}
              >
                {ins.type === 'PICKUP' ? '▲' : '▼'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-slate-900 truncate">{ins.unitNumber}</p>
                  <InspectionTypeBadge type={ins.type} />
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <StatusBadge status={ins.status} />
                  <span className="text-xs text-slate-400">
                    {ins.submittedAt ? timeAgo(ins.submittedAt) : timeAgo(ins.createdAt)}
                  </span>
                </div>
              </div>
              {ins.failCount > 0 && (
                <span className="badge-fail">⚠ {ins.failCount} fail</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Quick Stats */}
      <div className="mt-6 px-4">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">Your Stats (Today)</h2>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Completed', value: '2' },
            { label: 'Photos', value: '16' },
            { label: 'Issues', value: '1' },
          ].map(({ label, value }) => (
            <div key={label} className="card text-center">
              <p className="text-2xl font-bold text-slate-900">{value}</p>
              <p className="text-xs text-slate-500 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  return 'evening'
}
