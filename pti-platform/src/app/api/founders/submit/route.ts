import { NextRequest, NextResponse } from 'next/server'

const SHER_CHAT_ID = 5836863

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

    // Send both documents first, so they're visible above the summary.
    for (const [file, label] of [[articleFile, 'Article of Organization'], [saferFile, 'SAFER page screenshot']] as const) {
      const docForm = new FormData()
      docForm.append('chat_id', String(SHER_CHAT_ID))
      docForm.append('caption', `📄 ${label} — applicant uid ${uid}`)
      docForm.append('document', file, file.name)
      await fetch(api('sendDocument'), { method: 'POST', body: docForm })
    }

    // Summary message — field labels here must exactly match what the
    // bot's approve/decline handler parses back out.
    const text =
      `🆕 *Founders Hub Application*\n\n` +
      `Username: ${username || '(none)'}\n` +
      `Name: ${[firstname, lastname].filter(Boolean).join(' ') || '(unknown)'}\n` +
      `Full name: ${get('fullName')}\n` +
      `Company / Role: ${get('companyRole')}\n` +
      `LinkedIn: ${get('linkedin') || '—'}\n` +
      `Why join: ${get('whyJoin')}\n` +
      `Owner name: ${get('ownerName')}\n` +
      `Owner experience: ${get('ownerExperience')}\n` +
      `Company size: ${get('companySize')}\n` +
      `Company info: ${get('companyInfo')}\n` +
      `MC/DOT: ${get('mcDot')}\n` +
      `Truck count: ${get('truckCount')}`

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
