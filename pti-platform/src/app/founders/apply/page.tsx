'use client'
import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Loader2, CheckCircle2 } from 'lucide-react'

function ApplyForm() {
  const params = useSearchParams()
  const uid = params.get('uid') || ''
  const chatId = params.get('chat_id') || ''
  const username = params.get('username') || ''
  const firstname = params.get('firstname') || ''
  const lastname = params.get('lastname') || ''

  const [fields, setFields] = useState({
    fullName: '', companyRole: '', linkedin: '', whyJoin: '',
    ownerName: '', ownerExperience: '', companySize: '', companyInfo: '',
    mcDot: '', truckCount: '',
  })
  const [articleFile, setArticleFile] = useState<File | null>(null)
  const [saferFile, setSaferFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFields((f) => ({ ...f, [k]: e.target.value }))

  const requiredOk =
    fields.fullName.trim() && fields.companyRole.trim() && fields.whyJoin.trim() &&
    fields.ownerName.trim() && fields.ownerExperience.trim() && fields.companySize.trim() &&
    fields.companyInfo.trim() && fields.mcDot.trim() && fields.truckCount.trim() &&
    articleFile && saferFile

  const handleSubmit = async () => {
    if (!requiredOk) { setError('Please fill in every field and attach both documents.'); return }
    setSubmitting(true)
    setError('')
    try {
      const form = new FormData()
      form.append('uid', uid)
      form.append('chatId', chatId)
      form.append('username', username)
      form.append('firstname', firstname)
      form.append('lastname', lastname)
      Object.entries(fields).forEach(([k, v]) => form.append(k, v))
      form.append('articleOfOrg', articleFile!)
      form.append('saferScreenshot', saferFile!)

      const res = await fetch('/api/founders/submit', { method: 'POST', body: form })
      if (!res.ok) throw new Error((await res.json()).error || 'Submit failed')
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong — try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6 text-center">
        <CheckCircle2 className="mb-4 h-16 w-16 text-green-600" />
        <h1 className="text-xl font-bold text-slate-900">Application submitted</h1>
        <p className="mt-2 max-w-sm text-slate-600">
          Thanks — your application is with the team for review. You&apos;ll hear back here on Telegram.
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <div className="bg-gradient-to-br from-blue-700 to-blue-900 px-4 py-6 text-white">
        <h1 className="text-lg font-bold">Founders Hub — Application</h1>
        <p className="mt-1 text-sm text-blue-200">A few details, then two quick documents.</p>
      </div>

      <div className="space-y-4 px-4 py-4">
        <Field label="Full name" value={fields.fullName} onChange={set('fullName')} />
        <Field label="Company / Role" value={fields.companyRole} onChange={set('companyRole')} placeholder="e.g. Owner, Acme Trucking" />
        <Field label="LinkedIn (optional)" value={fields.linkedin} onChange={set('linkedin')} />
        <TextArea label="Why do you want to join?" value={fields.whyJoin} onChange={set('whyJoin')} />
        <Field label="Owner's name" value={fields.ownerName} onChange={set('ownerName')} />
        <TextArea label="Owner's experience" value={fields.ownerExperience} onChange={set('ownerExperience')} />
        <Field label="Company size" value={fields.companySize} onChange={set('companySize')} placeholder="e.g. 12 employees" />
        <TextArea label="Company information" value={fields.companyInfo} onChange={set('companyInfo')} />
        <Field label="MC / DOT number" value={fields.mcDot} onChange={set('mcDot')} />
        <Field label="Truck count" value={fields.truckCount} onChange={set('truckCount')} type="number" />

        <FileField label="Article of Organization" file={articleFile} onChange={setArticleFile} />
        <FileField label="SAFER page screenshot" file={saferFile} onChange={setSaferFile} />

        {error && <p className="text-sm font-semibold text-red-600">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full rounded-xl bg-blue-600 py-4 text-base font-black text-white disabled:opacity-50"
        >
          {submitting ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : 'Submit Application'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder?: string; type?: string
}) {
  return (
    <div className="card">
      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      <input type={type} value={value} onChange={onChange} placeholder={placeholder} className="input-field" />
    </div>
  )
}

function TextArea({ label, value, onChange }: {
  label: string; value: string; onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
}) {
  return (
    <div className="card">
      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      <textarea value={value} onChange={onChange} rows={3} className="input-field" />
    </div>
  )
}

function FileField({ label, file, onChange }: {
  label: string; file: File | null; onChange: (f: File | null) => void
}) {
  return (
    <div className="card">
      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      <input
        type="file"
        accept="image/*,application/pdf"
        onChange={(e) => onChange(e.target.files?.[0] || null)}
        className="text-sm"
      />
      {file && <p className="mt-1 text-xs text-green-600">✓ {file.name}</p>}
    </div>
  )
}

export default function FoundersApplyPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-blue-600" /></div>}>
      <ApplyForm />
    </Suspense>
  )
}
