'use client'
import { cn } from '@/lib/utils'
import { fuelLevelLabel } from '@/lib/utils'

interface FuelSliderProps {
  value: number
  onChange: (v: number) => void
}

export function FuelSlider({ value, onChange }: FuelSliderProps) {
  const pct = Math.round(value * 100)
  const color = pct <= 25 ? 'from-red-500 to-orange-500' : pct <= 50 ? 'from-orange-400 to-yellow-400' : 'from-green-400 to-emerald-500'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-600">Fuel Level</span>
        <span className={cn('text-sm font-bold', pct <= 25 ? 'text-red-600' : pct <= 50 ? 'text-orange-600' : 'text-green-600')}>
          {fuelLevelLabel(value)} ({pct}%)
        </span>
      </div>

      <div className="relative">
        <div className="h-2 rounded-full bg-slate-200">
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
          className="absolute inset-0 w-full opacity-0 cursor-pointer h-2"
          style={{ height: '8px' }}
        />
      </div>

      <div className="flex justify-between text-xs text-slate-400">
        <span>E</span>
        <span>1/4</span>
        <span>1/2</span>
        <span>3/4</span>
        <span>F</span>
      </div>
    </div>
  )
}
