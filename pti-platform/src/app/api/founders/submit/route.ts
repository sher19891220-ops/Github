import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const SHER_CHAT_ID = 5836863

async function fileToBase64(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer())
  return buf.toString('base64')
}

async function analyzeApplication(fields: Record<string, string>, saferFile: File | null) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const content: Anthropic.MessageParam['content'] = []

  if (saferFile && saferFile.type.startsWith('image/')) {
    const base64 = await fileToBase64(saferFile)
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: saferFile.type as 'image/jpeg' | 'image/png', data: base64 },
    })
  }

  content.push({
    type: 'text',
    text: `Review this Founders Hub membership application for a trucking-industry business network. The applicant is applying as a trucking company owner/operator.

Application details:
- Full name: ${fields.fullName}
- Company / Role: ${fields.companyRole}
- LinkedIn: ${fields.linkedin || 'not provided'}
- Why they want to join: ${fields.whyJoin}
- Owner's name: ${fields.ownerName}
- Owner's experience: ${fields.ownerExperience}
- Company size: ${fields.companySize}
- Company info: ${fields.companyInfo}
- MC/DOT number: ${fields.mcDot}
- Truck count claimed: ${fields.truckCount}

${saferFile && saferFile.type.startsWith('image/') ? 'A screenshot of the SAFER (FMCSA) safety page is attached — use it to check whether the MC/DOT number, company name, and truck count roughly match what the applicant claims, and note the safety rating if visible.' : 'No analyzable SAFER screenshot was attached, or it was not an image file — note this as unverifiable.'}

Reply with ONLY valid JSON, no other text:
{
  "summary": "2-3 sentence plain-language summary of who this applicant is and what they run",
  "consistency_check": "one sentence on whether the SAFER data (if visible) matches their claims, or 'not verifiable' if no usable screenshot",
  "flags": ["any concern worth the reviewer's attention — vague answers, mismatched numbers, missing info — empty array if none"],
  "overall_impression": "one sentence — genuine assessment, not just positive spin"
}`,
  })

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 800,
    messages: [{ role: 'user', content }],
  })

  const textBlock = res.content.find((b) => b.type === 'text')
  let raw = (textBlock && 'text' in textBlock ? textBlock.text : '').trim()
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim()

  try {
    return JSON.parse(raw)
  } catch {
    return { summary: '(AI summary failed to parse)', consistency_check: 'not verifiable', flags: [], overall_impression: raw.slice(0, 200) }
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = process.env.FOUNDERS_BOT_TOKEN
    if (!token) {
      return NextResponse.json({ error: 'FOUNDERS_BOT_TOKEN not configured' }, { status: 500 })
    }

    const form = await req.formData()
    const uid = form.get('uid') as string
    const chatId = form.get('chatId') as string
    const username = (form.get('username') as string) || ''
    const firstname = (form.get('firstname') as string) || ''
    const lastname = (form.get('lastname') as string) || ''
    const get = (k: string) => (form.get(k) as string) || ''

    const articleFile = form.get('articleOfOrg') as File | null
    const saferFile = form.get('saferScreenshot') as File | null

    if (!uid || !chatId) {
      return NextResponse.json({ error: 'Missing uid or chatId — open this link from the bot message, not directly.' }, { status: 400 })
    }
    if (!articleFile || !saferFile) {
      return NextResponse.json({ error: 'Both documents are required.' }, { status: 400 })
    }

    const api = (method: string) => `https://api.telegram.org/bot${token}/${method}`

    const fields = {
      fullName: get('fullName'), companyRole: get('companyRole'), linkedin: get('linkedin'),
      whyJoin: get('whyJoin'), ownerName: get('ownerName'), ownerExperience: get('ownerExperience'),
      companySize: get('companySize'), companyInfo: get('companyInfo'), mcDot: get('mcDot'),
      truckCount: get('truckCount'),
    }

    // Analyze before notifying — if this fails for any reason, the
    // application still goes to the reviewer, just without the AI summary.
    let analysis: { summary: string; consistency_check: string; flags: string[]; overall_impression: string } | null = null
    try {
      analysis = await analyzeApplication(fields, saferFile)
    } catch (e) {
      console.error('AI analysis failed:', e)
    }

    // Send both documents first, so they're visible above the summary.
    for (const [file, label] of [[articleFile, 'Article of Organization'], [saferFile, 'SAFER page screenshot']] as const) {
      const docForm = new FormData()
      docForm.append('chat_id', String(SHER_CHAT_ID))
      docForm.append('caption', `📄 ${label} — applicant uid ${uid}`)
      docForm.append('document', file, file.name)
      await fetch(api('sendDocument'), { method: 'POST', body: docForm })
    }

    const analysisBlock = analysis
      ? `🤖 *AI Summary*\n${analysis.summary}\n\n` +
        `*SAFER check:* ${analysis.consistency_check}\n` +
        (analysis.flags.length > 0 ? `*⚠️ Flags:* ${analysis.flags.join(' · ')}\n` : `*⚠️ Flags:* none\n`) +
        `*Overall:* ${analysis.overall_impression}\n\n———————————\n\n`
      : `⚠️ AI summary unavailable — review raw application below.\n\n———————————\n\n`

    // Field labels below this point must exactly match what the bot's
    // approve/decline handler parses back out — the AI summary above is
    // purely for the reviewer and isn't parsed.
    const text =
      `🆕 *Founders Hub Application*\n\n` +
      analysisBlock +
      `Username: ${username || '(none)'}\n` +
      `Name: ${[firstname, lastname].filter(Boolean).join(' ') || '(unknown)'}\n` +
      `Full name: ${fields.fullName}\n` +
      `Company / Role: ${fields.companyRole}\n` +
      `LinkedIn: ${fields.linkedin || '—'}\n` +
      `Why join: ${fields.whyJoin}\n` +
      `Owner name: ${fields.ownerName}\n` +
      `Owner experience: ${fields.ownerExperience}\n` +
      `Company size: ${fields.companySize}\n` +
      `Company info: ${fields.companyInfo}\n` +
      `MC/DOT: ${fields.mcDot}\n` +
      `Truck count: ${fields.truckCount}`

    const sendRes = await fetch(api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: SHER_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `fhapprove_${uid}_${chatId}` },
            { text: '❌ Decline', callback_data: `fhdecline_${uid}_${chatId}` },
          ]],
        },
      }),
    })
    const sendData = await sendRes.json()
    if (!sendData.ok) {
      return NextResponse.json({ error: 'Failed to notify reviewer: ' + sendData.description }, { status: 502 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('founders submit error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
