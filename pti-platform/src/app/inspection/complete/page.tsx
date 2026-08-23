'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2, Download, Share2, LogOut,
  MessageCircle, Smartphone, Info, Loader2, AlertTriangle,
  ScanSearch, CheckCircle, XCircle, TriangleAlert,
} from 'lucide-react'
import { useInspectionStore } from '@/store/inspectionStore'

type PhotoAnalysis = {
  angleLabel: string
  status: 'OK' | 'WARNING' | 'CRITICAL' | 'analyzing' | 'failed'
  issues: string[]
  details: string
}

export default function CompletePage() {
  const router = useRouter()
  const store = useInspectionStore()
  const [shareMsg, setShareMsg] = useState('')
  const [reportStatus, setReportStatus] = useState<'sending' | 'sent' | 'failed' | 'idle'>('idle')
  const [analyses, setAnalyses] = useState<PhotoAnalysis[]>([])
  const [analysisStatus, setAnalysisStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const sentRef = useRef(false)
  const analysisRef = useRef(false)

  const driver     = store.driver
  const vehicle    = store.vehicle
  const inspType   = store.inspectionType === 'PICKUP' ? 'PICKUP' : store.inspectionType === 'DROP_OFF' ? 'DROP-OFF' : null
  const now        = new Date()
  const dateStr    = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const timeStr    = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  const gpsCoords  = store.gps ? `${store.gps.lat.toFixed(5)}, ${store.gps.lng.toFixed(5)}` : 'N/A'
  const locationLine = store.locationStr
    ? `${store.locationStr} (${gpsCoords})`
    : gpsCoords
  const photoCount = store.photos.length

  // Guard: if session was never initialized, go back to start
  useEffect(() => {
    if (!store.driver || !store.vehicle || !store.inspectionType) {
      router.replace('/inspection/start')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const summaryText = [
    `🚛 PTI INSPECTION REPORT`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Type:    ${inspType ?? '—'}`,
    `Trailer: ${vehicle?.unitNumber ?? '—'}`,
    `Driver:  ${driver?.name ?? '—'}`,
    `Company: ${driver?.company ?? vehicle?.company ?? '—'}`,
    `Date:    ${dateStr}`,
    `Time:    ${timeStr}`,
    `Location: ${locationLine}`,
    `Photos:  ${photoCount}`,
    store.comments.trim() ? `Notes:   ${store.comments.trim()}` : '',
  ].filter(Boolean).join('\n')

  useEffect(() => {
    if (sentRef.current) return
    sentRef.current = true
    sendTelegramReport()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (analysisRef.current || store.photos.length === 0) return
    analysisRef.current = true
    runPhotoAnalysis()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function runPhotoAnalysis() {
    setAnalysisStatus('running')
    const initial: PhotoAnalysis[] = store.photos.map((p) => ({
      angleLabel: p.angleLabel,
      status: 'analyzing',
      issues: [],
      details: '',
    }))
    setAnalyses(initial)

    await Promise.all(
      store.photos.map(async (photo, idx) => {
        try {
          const res = await fetch('/api/analyze-photos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl: photo.dataUrl, angleLabel: photo.angleLabel }),
          })
          const data = await res.json()
          setAnalyses((prev) => {
            const next = [...prev]
            next[idx] = {
              angleLabel: photo.angleLabel,
              status: data.ok ? (data.status as PhotoAnalysis['status']) : 'failed',
              issues: data.issues ?? [],
              details: data.details ?? (data.ok ? '' : 'Analysis failed'),
            }
            return next
          })
        } catch {
          setAnalyses((prev) => {
            const next = [...prev]
            next[idx] = { angleLabel: photo.angleLabel, status: 'failed', issues: [], details: 'Could not analyze' }
            return next
          })
        }
      })
    )
    setAnalysisStatus('done')
  }

  async function sendTelegramReport() {
    if (!store.driver || !store.vehicle) return
    setReportStatus('sending')
    try {
      const chatId = store.sourceChatId ?? undefined

      // 1. Send text summary
      const textRes = await fetch('/api/send-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'text', text: summaryText, chatId }),
      })
      if (!textRes.ok) {
        const errBody = await textRes.json().catch(() => ({}))
        throw new Error(`Text send failed: ${JSON.stringify(errBody)}`)
      }

      // 2. Send photos in chunks of 2 (each ~500 KB–1 MB base64, keep body <3 MB)
      const allPhotos = store.photos.map((p) => ({ dataUrl: p.dataUrl, caption: p.angleLabel }))
      const CHUNK = 2
      for (let i = 0; i < allPhotos.length; i += CHUNK) {
        const chunk = allPhotos.slice(i, i + CHUNK)
        const res = await fetch('/api/send-report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'photos', photos: chunk, chatId }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          console.warn('Photo batch failed:', err)
        }
      }

      // 3. Send driver signature if present
      if (store.signatureDataUrl) {
        await fetch('/api/send-report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'photos',
            photos: [{ dataUrl: store.signatureDataUrl, caption: `✍️ Signature — ${driver?.name ?? 'Driver'}` }],
            chatId,
          }),
        }).catch(() => {})
      }

      setReportStatus('sent')
    } catch (err) {
      console.error('Telegram report error:', err)
      setReportStatus('failed')
    }
  }

  // Send AI findings as a follow-up Telegram message once analysis is done
  useEffect(() => {
    if (analysisStatus !== 'done' || reportStatus === 'idle' || reportStatus === 'sending') return
    const findings = analyses.filter((a) => a.status === 'WARNING' || a.status === 'CRITICAL')
    if (findings.length === 0) return

    const chatId = store.sourceChatId ?? undefined
    const criticals = findings.filter((a) => a.status === 'CRITICAL')
    const warnings  = findings.filter((a) => a.status === 'WARNING')

    const lines = [
      `🔍 AI DAMAGE ANALYSIS`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Trailer: ${vehicle?.unitNumber ?? '—'}`,
      criticals.length > 0 ? `🚨 CRITICAL (${criticals.length}): ${criticals.map((a) => a.angleLabel).join(', ')}` : '',
      warnings.length > 0  ? `⚠️ WARNING (${warnings.length}): ${warnings.map((a) => a.angleLabel).join(', ')}` : '',
      ``,
      ...findings.map((a) => `${a.status === 'CRITICAL' ? '🚨' : '⚠️'} ${a.angleLabel}:\n${a.issues.map((i) => `  • ${i}`).join('\n')}`),
    ].filter((l) => l !== undefined && l !== null)

    fetch('/api/send-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'text', text: lines.join('\n'), chatId }),
    }).catch(() => {})
  }, [analysisStatus, reportStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  function buildAiFindingsHtml() {
    if (analyses.length === 0 || analysisStatus !== 'done') return ''
    const issues = analyses.filter((a) => a.status === 'WARNING' || a.status === 'CRITICAL')
    if (issues.length === 0) return `<div style="margin:16px 0;padding:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:6px;font-size:13px;color:#166534">✅ AI Analysis: No significant damage detected</div>`
    return `<h3 style="margin:16px 0 8px">AI Damage Analysis</h3>
      ${issues.map((a) => `<div style="margin-bottom:8px;padding:10px 12px;background:${a.status === 'CRITICAL' ? '#fef2f2' : '#fffbeb'};border:1px solid ${a.status === 'CRITICAL' ? '#fca5a5' : '#fcd34d'};border-radius:6px">
        <div style="font-size:12px;font-weight:700;color:${a.status === 'CRITICAL' ? '#991b1b' : '#92400e'};margin-bottom:4px">${a.status === 'CRITICAL' ? '🚨' : '⚠️'} ${a.angleLabel}</div>
        <div style="font-size:12px;color:#374151">${a.issues.map((i) => `• ${i}`).join('<br>')}</div>
      </div>`).join('')}`
  }

  function handleDownloadPDF() {
    const sig = store.signatureDataUrl

    const rows = [
      ['Type', inspType ?? '—'],
      ['Trailer', vehicle?.unitNumber ?? '—'],
      ['Driver', driver?.name ?? '—'],
      ['Company', driver?.company ?? vehicle?.company ?? '—'],
      ['Date', dateStr],
      ['Time', timeStr],
      ['Location', locationLine],
      ['Photos', String(photoCount)],
      ...(store.comments.trim() ? [['Notes', store.comments.trim()]] : []),
    ]

    const photosHtml = store.photos.length > 0
      ? `<h3 style="margin:16px 0 8px">Inspection Photos (${store.photos.length})</h3>
         <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:16px">
           ${store.photos.map((p) => `<div style="break-inside:avoid;page-break-inside:avoid">
             <div style="font-size:11px;color:#64748b;margin-bottom:4px;font-weight:600;text-align:center">${p.angleLabel}</div>
             <img src="${p.dataUrl}" style="width:100%;height:auto;border:1px solid #e2e8f0;border-radius:4px;display:block"/>
           </div>`).join('')}
         </div>`
      : ''

    const sigHtml = sig
      ? `<h3 style="margin:16px 0 6px">Driver Signature</h3><img src="${sig}" style="height:80px;border:1px solid #ccc" />`
      : ''

    const aiFindingsHtml = buildAiFindingsHtml()

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>PTI Inspection Report — ${vehicle?.unitNumber ?? 'Trailer'}</title>
<style>
  body{font-family:sans-serif;padding:32px;max-width:760px;margin:0 auto;color:#1e293b}
  h1{font-size:22px;margin-bottom:4px}
  h2{font-size:15px;color:#64748b;font-weight:normal;margin:0 0 20px}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  td{padding:6px 10px;border:1px solid #e2e8f0;font-size:14px}
  td:first-child{font-weight:600;width:110px;background:#f8fafc}
  .footer{margin-top:40px;font-size:11px;color:#94a3b8}
</style></head><body>
<h1>PTI Trailer Inspection Report</h1>
<h2>${inspType} Inspection</h2>
<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
${aiFindingsHtml}
${photosHtml}${sigHtml}
<div class="footer">Generated by PTI Inspection System · ${new Date().toISOString()}</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`

    const w = window.open('', '_blank')
    if (w) {
      w.document.write(html)
      w.document.close()
    } else {
      window.print()
    }
  }

  async function handleShare() {
    if (navigator.share) {
      try {
        const photoFiles: File[] = []
        for (const p of store.photos) {
          try {
            const res = await fetch(p.dataUrl)
            const blob = await res.blob()
            photoFiles.push(new File([blob], `${p.angleLabel.replace(/\s+/g, '_')}.jpg`, { type: 'image/jpeg' }))
          } catch { /* skip individual photo on error */ }
        }
        const shareData: ShareData = {
          title: `PTI Inspection — ${vehicle?.unitNumber ?? 'Trailer'}`,
          text: summaryText,
          ...(photoFiles.length > 0 && navigator.canShare?.({ files: photoFiles }) ? { files: photoFiles } : {}),
        }
        await navigator.share(shareData)
      } catch {
        fallbackCopy()
      }
    } else {
      fallbackCopy()
    }
  }

  function fallbackCopy() {
    navigator.clipboard.writeText(summaryText).then(() => {
      setShareMsg('Summary copied to clipboard!')
      setTimeout(() => setShareMsg(''), 3000)
    }).catch(() => {
      setShareMsg('Could not copy — please screenshot this page.')
      setTimeout(() => setShareMsg(''), 4000)
    })
  }

  function handleExit() {
    store.reset()
    router.push('/inspection/start')
  }

  const criticalCount = analyses.filter((a) => a.status === 'CRITICAL').length
  const warningCount  = analyses.filter((a) => a.status === 'WARNING').length
  const okCount       = analyses.filter((a) => a.status === 'OK').length

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Print-only report */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-show { display: block !important; }
          body { background: white; }
        }
        .print-show { display: none; }
      `}</style>

      {/* Print view */}
      <div className="print-show p-8 text-sm font-mono">
        <h1 className="text-2xl font-bold mb-2">PTI Trailer Inspection Report</h1>
        <pre className="whitespace-pre-wrap">{summaryText}</pre>
        {store.signatureDataUrl && (
          <div className="mt-4">
            <strong>Signature:</strong>
            <img src={store.signatureDataUrl} alt="Signature" className="mt-1 border" style={{ height: 80 }} />
          </div>
        )}
        <div className="mt-4 text-xs text-slate-400">Generated by PTI Inspection System</div>
      </div>

      {/* Screen view */}
      <div className="no-print pb-32">
        {/* Success header */}
        <div className="bg-gradient-to-br from-green-600 to-green-800 text-white safe-top px-4 pt-6 pb-8">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/20 mb-4">
              <CheckCircle2 className="h-10 w-10" />
            </div>
            <h1 className="text-2xl font-black">Inspection Complete!</h1>
            <p className="text-green-100 mt-1 text-sm">
              {inspType ?? '—'} · Trailer {vehicle?.unitNumber ?? '—'}
            </p>
          </div>
        </div>

        <div className="px-4 -mt-4 space-y-4">

          {/* Quick stats */}
          <div className="card">
            <div className="grid grid-cols-2 divide-x divide-slate-100">
              <div className="text-center pr-3">
                <div className="text-2xl font-black text-blue-600">{photoCount}</div>
                <div className="text-xs text-slate-500">Photos</div>
              </div>
              <div className="text-center pl-3">
                <div className="text-2xl font-black text-slate-700">
                  {store.tireInspections.filter((t) => t.condition !== null).length}/8
                </div>
                <div className="text-xs text-slate-500">Tires</div>
              </div>
            </div>
          </div>

          {/* AI Analysis card */}
          {photoCount > 0 && (
            <div className="card">
              <div className="flex items-center gap-2 mb-3">
                <ScanSearch className="h-5 w-5 text-purple-600" />
                <h3 className="font-semibold text-slate-800">AI Damage Analysis</h3>
                {analysisStatus === 'running' && (
                  <Loader2 className="h-4 w-4 text-purple-500 animate-spin ml-auto" />
                )}
                {analysisStatus === 'done' && criticalCount === 0 && warningCount === 0 && (
                  <span className="ml-auto text-xs font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">All Clear</span>
                )}
                {analysisStatus === 'done' && (criticalCount > 0 || warningCount > 0) && (
                  <span className="ml-auto text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded-full">
                    {criticalCount > 0 ? `${criticalCount} Critical` : `${warningCount} Warning`}
                  </span>
                )}
              </div>

              {analysisStatus === 'running' && (
                <p className="text-xs text-slate-500">Analyzing {photoCount} photo{photoCount !== 1 ? 's' : ''} for damage…</p>
              )}

              {analyses.length > 0 && (
                <div className="space-y-2">
                  {analyses.map((a, i) => (
                    <div key={i} className={`rounded-lg p-3 text-sm ${
                      a.status === 'CRITICAL' ? 'bg-red-50 border border-red-200' :
                      a.status === 'WARNING'  ? 'bg-yellow-50 border border-yellow-200' :
                      a.status === 'OK'       ? 'bg-green-50 border border-green-100' :
                      a.status === 'failed'   ? 'bg-slate-50 border border-slate-200' :
                      'bg-slate-50 border border-slate-100'
                    }`}>
                      <div className="flex items-center gap-2">
                        {a.status === 'analyzing' && <Loader2 className="h-4 w-4 text-slate-400 animate-spin flex-shrink-0" />}
                        {a.status === 'CRITICAL'  && <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />}
                        {a.status === 'WARNING'   && <TriangleAlert className="h-4 w-4 text-yellow-500 flex-shrink-0" />}
                        {a.status === 'OK'        && <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />}
                        {a.status === 'failed'    && <AlertTriangle className="h-4 w-4 text-slate-400 flex-shrink-0" />}
                        <span className="font-semibold text-slate-700 text-xs">{a.angleLabel}</span>
                        {a.status !== 'analyzing' && a.status !== 'failed' && (
                          <span className={`ml-auto text-xs font-bold ${
                            a.status === 'CRITICAL' ? 'text-red-600' :
                            a.status === 'WARNING'  ? 'text-yellow-700' :
                            'text-green-600'
                          }`}>{a.status}</span>
                        )}
                      </div>
                      {a.issues.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5 pl-6">
                          {a.issues.map((issue, j) => (
                            <li key={j} className="text-xs text-slate-600">• {issue}</li>
                          ))}
                        </ul>
                      )}
                      {a.details && a.status !== 'OK' && (
                        <p className="mt-1 text-xs text-slate-500 pl-6">{a.details}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {analysisStatus === 'done' && criticalCount === 0 && warningCount === 0 && okCount > 0 && (
                <p className="text-xs text-green-700 mt-2">No damage or issues detected in any photo.</p>
              )}
            </div>
          )}

          {/* Telegram status */}
          <div className={`card border ${
            reportStatus === 'sent' ? 'border-green-200 bg-green-50' :
            reportStatus === 'failed' ? 'border-red-200 bg-red-50' :
            'border-blue-100 bg-blue-50'
          }`}>
            <div className="flex items-center gap-2 mb-2">
              {reportStatus === 'sending' && <Loader2 className="h-5 w-5 text-blue-500 animate-spin flex-shrink-0" />}
              {reportStatus === 'sent' && <MessageCircle className="h-5 w-5 text-green-600 flex-shrink-0" />}
              {reportStatus === 'failed' && <AlertTriangle className="h-5 w-5 text-red-500 flex-shrink-0" />}
              {reportStatus === 'idle' && <Info className="h-5 w-5 text-blue-600 flex-shrink-0" />}
              <h3 className={`font-semibold ${
                reportStatus === 'sent' ? 'text-green-800' :
                reportStatus === 'failed' ? 'text-red-700' :
                'text-blue-800'
              }`}>
                {reportStatus === 'sending' && 'Sending report to Telegram…'}
                {reportStatus === 'sent' && 'Report sent to Telegram!'}
                {reportStatus === 'failed' && 'Telegram send failed'}
                {reportStatus === 'idle' && 'Report'}
              </h3>
            </div>
            <div className="space-y-2 text-sm text-slate-700">
              <div className="flex items-start gap-3">
                <MessageCircle className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-semibold">Telegram Group</div>
                  <div className="text-slate-600 text-xs mt-0.5">
                    {reportStatus === 'sent'
                      ? 'Summary and all photos delivered to your dispatch group via @Pti_check_bot.'
                      : reportStatus === 'failed'
                      ? 'Could not reach Telegram. Use Download PDF or Share to save the report manually.'
                      : 'Sending summary and photos to your dispatch group via @Pti_check_bot.'}
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Smartphone className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-semibold">This Device</div>
                  <div className="text-slate-600 text-xs mt-0.5">
                    Full report with photos and signature is available via <strong>Download PDF</strong>.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Summary preview */}
          <div className="card">
            <h3 className="font-semibold text-slate-800 mb-3">Report Summary</h3>
            <pre className="text-xs text-slate-600 whitespace-pre-wrap font-mono bg-slate-50 rounded-lg p-3">
              {summaryText}
            </pre>
            {store.signatureDataUrl && (
              <div className="mt-3">
                <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1">Signature</div>
                <img
                  src={store.signatureDataUrl}
                  alt="Driver signature"
                  className="border border-slate-200 rounded-lg"
                  style={{ maxHeight: 80 }}
                />
              </div>
            )}
          </div>

          {shareMsg && (
            <div className="bg-green-50 border border-green-200 text-green-700 text-sm text-center rounded-xl py-2 px-4">
              {shareMsg}
            </div>
          )}

        </div>
      </div>

      {/* Bottom actions */}
      <div className="no-print fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 py-3 space-y-2">
        <div className="flex gap-3">
          <button
            onClick={handleDownloadPDF}
            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 text-white font-semibold"
          >
            <Download className="h-5 w-5" />
            Download PDF
          </button>
          <button
            onClick={handleShare}
            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-slate-100 text-slate-700 font-semibold"
          >
            <Share2 className="h-5 w-5" />
            Share
          </button>
        </div>
        <button
          onClick={handleExit}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-red-200 text-red-600 font-semibold"
        >
          <LogOut className="h-5 w-5" />
          Exit Inspection
        </button>
      </div>
    </div>
  )
}
