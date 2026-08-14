'use client'
import { ArrowLeft, MoreVertical } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface TopBarProps {
  title: string
  subtitle?: string
  showBack?: boolean
  backHref?: string
  rightAction?: React.ReactNode
  className?: string
}

export function TopBar({ title, subtitle, showBack = false, backHref, rightAction, className = '' }: TopBarProps) {
  const router = useRouter()

  const handleBack = () => {
    if (backHref) router.push(backHref)
    else router.back()
  }

  return (
    <header className={`sticky top-0 z-40 bg-white border-b border-slate-100 safe-top ${className}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        {showBack && (
          <button
            onClick={handleBack}
            className="-ml-1 flex h-9 w-9 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100 active:bg-slate-200"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="truncate text-base font-semibold text-slate-900">{title}</h1>
          {subtitle && <p className="truncate text-xs text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
        {rightAction && <div className="flex-shrink-0">{rightAction}</div>}
      </div>
    </header>
  )
}
