import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
      <div className="text-6xl font-black text-slate-200">404</div>
      <h1 className="text-xl font-bold text-slate-800">Page not found</h1>
      <p className="text-sm text-slate-500">This inspection link may have expired or is invalid.</p>
      <Link href="/" className="btn-primary mt-2">
        Back to Home
      </Link>
    </div>
  )
}
