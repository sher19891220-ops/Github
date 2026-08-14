'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle, Download, Share2, Home, FileText } from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'
import { CompanyBadge, InspectionTypeBadge } from '@/components/ui/Badge'
import { formatDateTime } from '@/lib/utils'

export default function CompletePage() {
  const router = useRouter()
  const { driver, vehicle, inspectionType, photos, checklist, sessionToken, reset } = useInspectionStore()
  const [uploadDone, setUploadDone] = useState(false)
  const [submittedAt] = useState(() => new Date().toISOString())

  useEffect(() => {
    if (!driver || !vehicle || !inspectionType) {
      router.replace('/')
    }
  }, [driver, vehicle, inspectionType, router])

  useEffect(() => {
    const t = setTimeout(() => setUploadDone(true), 2000)
    return () => clearTimeout(t)
  }, [])

  const failCount = checklist.filter((i) => i.status === 'FAIL').length

  if (!driver || !vehicle || !inspectionType) {
    return null
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-700 to-blue-900 flex flex-col items-center justify-center px-6 safe-top safe-bottom">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex flex-col items-center gap-3 text-white">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-400/20 ring-8 ring-green-400/10 check-pop">
            <CheckCircle className="h-12 w-12 text-green-400" />
          </div>
          <h1 className="text-2xl font-bold">Submitted!</h1>
          <p className="text-blue-200 text-sm text-center">Your inspection has been recorded and uploaded.</p>
        </div>

        <div className="rounded-2xl bg-white/10 backdrop-blur p-4 space-y-3">
          <div className="flex items-center justify-between">
            <InspectionTypeBadge type={inspectionType} />
            {driver.company && <CompanyBadge company={driver.company} />}
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-blue-200 text-xs">Driver</p>
              <p className="text-white font-semibold">{driver.name}</p>
            </div>
            <div>
              <p className="text-blue-200 text-xs">Unit #</p>
              <p className="text-white font-semibold">{vehicle.unitNumber}</p>
            </div>
            <div>
              <p className="text-blue-200 text-xs">Photos</p>
              <p className="text-white font-semibold">{photos.length}</p>
            </div>
            <div>
              <p className="text-blue-200 text-xs">Issues</p>
              <p className={`font-semibold ${failCount > 0 ? 'text-red-300' : 'text-green-300'}`}>
                {failCount > 0 ? `${failCount} failed` : 'None'}
              </p>
            </div>
          </div>

          <div className="border-t border-white/10 pt-3">
            <p className="text-xs text-blue-200">Session Token</p>
            <p className="text-white font-mono text-sm">{sessionToken}</p>
            <p className="text-xs text-blue-300 mt-1">{formatDateTime(submittedAt)}</p>
          </div>

          <div className={`rounded-xl px-3 py-2 text-xs font-medium flex items-center gap-2 ${
            uploadDone ? 'bg-green-400/20 text-green-300' : 'bg-blue-400/20 text-blue-200'
          }`}>
            {uploadDone
              ? <span>✓ Uploaded to cloud &amp; PTI bot notified</span>
              : <span>⧗ Uploading to cloud storage…</span>}
          </div>
        </div>

        <div className="space-y-2">
          <button className="btn-secondary w-full flex items-center justify-center gap-2">
            <FileText className="h-4 w-4" />
            Download PDF Report
          </button>
          <button className="btn-secondary w-full flex items-center justify-center gap-2">
            <Share2 className="h-4 w-4" />
            Share Report
          </button>
          <button
            onClick={() => { reset(); router.push('/') }}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            <Home className="h-4 w-4" />
            Back to Home
          </button>
        </div>
      </div>
    </div>
  )
}
