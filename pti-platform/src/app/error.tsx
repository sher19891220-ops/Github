'use client'
import { useEffect } from 'react'

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error('App error:', error)
  }, [error])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
      <div className="text-4xl">⚠️</div>
      <h2 className="text-lg font-bold text-slate-800">Something went wrong</h2>
      <p className="text-sm text-slate-500 max-w-xs">{error.message || 'An unexpected error occurred.'}</p>
      <button onClick={reset} className="btn-primary mt-2">Try again</button>
    </div>
  )
}
