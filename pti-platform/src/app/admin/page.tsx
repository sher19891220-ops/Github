'use client'
import { useState } from 'react'
import {
  LayoutDashboard, Users, Truck, AlertTriangle,
  TrendingUp, Clock, MapPin, Download, Eye, Activity
} from 'lucide-react'
import { TopBar } from '@/components/ui/TopBar'
import { InspectionTypeBadge, StatusBadge, CompanyBadge } from '@/components/ui/Badge'
import { MOCK_ADMIN_STATS, MOCK_FLEET, MOCK_INSPECTIONS } from '@/lib/mockData'
import { timeAgo, formatDateTime } from '@/lib/utils'
import { cn } from '@/lib/utils'

type Tab = 'overview' | 'fleet' | 'inspections'

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [company, setCompany] = useState<string>('ALL')

  const filteredInspections = company === 'ALL'
    ? MOCK_INSPECTIONS
    : MOCK_INSPECTIONS.filter((i) => i.company === company)

  const filteredFleet = company === 'ALL'
    ? MOCK_FLEET
    : MOCK_FLEET.filter((f) => f.vehicle.company === company)

  return (
    <div className="min-h-screen bg-slate-50 pb-8">
      <TopBar
        title="Admin Dashboard"
        subtitle="Fleet Manager View"
        showBack
        backHref="/"
        rightAction={
          <span className="flex h-2.5 w-2.5 rounded-full bg-green-400 ring-2 ring-green-100" />
        }
      />

      {/* Company filter */}
      <div className="bg-white border-b border-slate-100 px-4 py-2 flex gap-2 overflow-x-auto no-scrollbar">
        {['ALL', 'Zone LLC', 'Xtrack LLC', 'AFG Transportco'].map((c) => (
          <button
            key={c}
            onClick={() => setCompany(c)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors',
              company === c ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white">
        {(['overview', 'fleet', 'inspections'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'flex-1 py-3 text-xs font-semibold capitalize transition-colors',
              tab === t
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-slate-500'
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === 'overview' && <OverviewTab />}
        {tab === 'fleet' && <FleetTab fleet={filteredFleet} />}
        {tab === 'inspections' && <InspectionsTab inspections={filteredInspections} />}
      </div>
    </div>
  )
}

function OverviewTab() {
  const stats = MOCK_ADMIN_STATS
  return (
    <div className="space-y-4">
      {/* KPI Grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard icon={Activity} label="Today's Inspections" value={String(stats.totalInspectionsToday)} color="blue" />
        <StatCard icon={TrendingUp} label="This Week" value={String(stats.totalInspectionsWeek)} color="violet" />
        <StatCard icon={AlertTriangle} label="Fail Rate Today" value={`${stats.failRateToday}%`} color={stats.failRateToday > 10 ? 'red' : 'green'} />
        <StatCard icon={Clock} label="Avg Completion" value={`${stats.avgCompletionMinutes}m`} color="orange" />
        <StatCard icon={Users} label="Active Drivers" value={String(stats.activeDrivers)} color="teal" />
        <StatCard icon={Eye} label="Pending Review" value={String(stats.pendingReview)} color="amber" />
      </div>

      {/* Recent activity */}
      <div className="card">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Recent Activity</h3>
        <div className="space-y-3">
          {MOCK_INSPECTIONS.map((ins) => (
            <div key={ins.id} className="flex items-center gap-3">
              <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-white text-xs font-bold ${
                ins.type === 'PICKUP' ? 'bg-green-500' : 'bg-orange-500'
              }`}>
                {ins.type === 'PICKUP' ? '▲' : '▼'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">{ins.driverName} · {ins.unitNumber}</p>
                <p className="text-xs text-slate-400">{ins.submittedAt ? timeAgo(ins.submittedAt) : 'In progress'}</p>
              </div>
              <StatusBadge status={ins.status} />
            </div>
          ))}
        </div>
      </div>

      {/* Fail breakdown */}
      <div className="card">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Top Defect Categories</h3>
        {[
          { cat: 'Tires & Wheels', count: 4, pct: 40 },
          { cat: 'Lights & Signals', count: 3, pct: 30 },
          { cat: 'Brakes', count: 2, pct: 20 },
          { cat: 'Engine Compartment', count: 1, pct: 10 },
        ].map(({ cat, count, pct }) => (
          <div key={cat} className="mb-2 last:mb-0">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-600">{cat}</span>
              <span className="text-slate-500 font-medium">{count} issues</span>
            </div>
            <div className="h-2 rounded-full bg-slate-100">
              <div className="h-2 rounded-full bg-red-400" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ))}
      </div>

      <button className="btn-secondary w-full flex items-center justify-center gap-2">
        <Download className="h-4 w-4" />
        Export Report (CSV / PDF)
      </button>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }: { icon: typeof Activity; label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700', violet: 'bg-violet-50 text-violet-700',
    red: 'bg-red-50 text-red-700', green: 'bg-green-50 text-green-700',
    orange: 'bg-orange-50 text-orange-700', teal: 'bg-teal-50 text-teal-700',
    amber: 'bg-amber-50 text-amber-700',
  }
  return (
    <div className="card flex items-start gap-3">
      <div className={cn('flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl', colorMap[color])}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        <p className="text-xs text-slate-500 mt-0.5 leading-tight">{label}</p>
      </div>
    </div>
  )
}

function FleetTab({ fleet }: { fleet: typeof MOCK_FLEET }) {
  return (
    <div className="space-y-3">
      {fleet.map(({ vehicle, currentDriver, lastInspection, gps, status }) => (
        <div key={vehicle.id} className="card space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-slate-400" />
                <p className="font-bold text-slate-900">{vehicle.unitNumber}</p>
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-semibold',
                  status === 'ACTIVE' ? 'bg-green-100 text-green-700' :
                  status === 'IDLE' ? 'bg-slate-100 text-slate-600' :
                  'bg-red-100 text-red-700'
                )}>
                  {status}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">{vehicle.year} {vehicle.make} {vehicle.model}</p>
            </div>
            <CompanyBadge company={vehicle.company} />
          </div>

          {currentDriver && (
            <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">
                {currentDriver.avatarInitials}
              </div>
              <div>
                <p className="text-sm font-medium text-slate-800">{currentDriver.name}</p>
                <p className="text-xs text-slate-500">CDL: {currentDriver.licenseNumber}</p>
              </div>
            </div>
          )}

          {gps && (
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <MapPin className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
              <span className="truncate">{gps.address || `${gps.lat.toFixed(4)}, ${gps.lng.toFixed(4)}`}</span>
              <span className="text-slate-300 flex-shrink-0">· {timeAgo(gps.timestamp)}</span>
            </div>
          )}

          {lastInspection && (
            <div className="flex items-center justify-between border-t border-slate-100 pt-2">
              <div className="flex items-center gap-2">
                <InspectionTypeBadge type={lastInspection.type} />
                <span className="text-xs text-slate-400">
                  {lastInspection.submittedAt ? timeAgo(lastInspection.submittedAt) : 'In progress'}
                </span>
              </div>
              {lastInspection.failCount > 0 && (
                <span className="badge-fail">⚠ {lastInspection.failCount}</span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function InspectionsTab({ inspections }: { inspections: typeof MOCK_INSPECTIONS }) {
  return (
    <div className="space-y-3">
      {inspections.map((ins) => (
        <div key={ins.id} className="card space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <InspectionTypeBadge type={ins.type} />
              <p className="font-semibold text-slate-900">{ins.unitNumber}</p>
            </div>
            <StatusBadge status={ins.status} />
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>{ins.driverName}</span>
            <span>·</span>
            <CompanyBadge company={ins.company} />
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 pt-2">
            <span className="text-xs text-slate-400">
              {ins.submittedAt ? formatDateTime(ins.submittedAt) : 'In progress'}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">📷 {ins.photoCount}</span>
              {ins.failCount > 0 && <span className="badge-fail">⚠ {ins.failCount}</span>}
              {ins.hasPdf && (
                <button className="flex items-center gap-1 text-xs text-blue-600 font-medium">
                  <Download className="h-3 w-3" /> PDF
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
