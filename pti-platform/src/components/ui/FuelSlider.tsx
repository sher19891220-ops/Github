'use client'
import { cn, fuelLevelLabel } from '@/lib/utils'

interface FuelSliderProps {
  value: number
  onChange: (v: number) => void
}

export function FuelSlider({ value, onChange }: FuelSliderProps) {
  const pct = Math.round(value * 100)
  const color =
    pct <= 25 ? 'from-red-500 to-orange-500'
    : pct <= 50 ? 'from-orange-400 to-yellow-400'
    : 'from-green-400 to-emerald-500'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-600">Fuel Level</span>
        <span className={cn('text-sm font-bold', pct <= 25 ? 'text-red-600' : pct <= 50 ? 'text-orange-600' : 'text-green-600')}>
          {fuelLevelLabel(value)} ({pct}%)
        </span>
      </div>

      <div className="relative h-8 flex items-center">
        <div className="absolute inset-x-0 h-2 rounded-full bg-slate-200">
          <div
            className={cn('h-2 rounded-full bg-gradient-to-r transition-all', color)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          className="relative z-10 w-full cursor-pointer opacity-0"
        />
      </div>

      <div className="flex justify-between text-xs text-slate-400">
        {['E', '1/4', '1/2', '3/4', 'F'].map((l) => <span key={l}>{l}</span>)}
      </div>
    </div>
  )
}
