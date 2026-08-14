import React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Step {
  label: string
  completed: boolean
  active: boolean
}

interface StepProgressProps {
  steps: Step[]
  className?: string
}

export function StepProgress({ steps, className }: StepProgressProps) {
  return (
    <div className={cn('flex items-center', className)}>
      {steps.map((step, i) => (
        <React.Fragment key={step.label}>
          <div className="flex flex-col items-center gap-1">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all',
                step.completed
                  ? 'bg-blue-600 text-white'
                  : step.active
                  ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                  : 'bg-slate-100 text-slate-400'
              )}
            >
              {step.completed ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <span
              className={cn(
                'text-[10px] font-medium whitespace-nowrap',
                step.active ? 'text-blue-600' : step.completed ? 'text-slate-600' : 'text-slate-400'
              )}
            >
              {step.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={cn(
                'flex-1 h-0.5 mx-1 mb-4 rounded transition-all',
                step.completed ? 'bg-blue-600' : 'bg-slate-200'
              )}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  )
}
