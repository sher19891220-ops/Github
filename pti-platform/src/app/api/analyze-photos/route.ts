import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const client = new Anthropic()

const SYSTEM_PROMPT = `You are a commercial trailer inspection AI. Analyze the photo and identify any visible issues.

Return a JSON object with exactly these fields:
{
  "status": "OK" | "WARNING" | "CRITICAL",
  "issues": ["short issue description", ...],
  "details": "one or two sentence summary"
}

Guidelines:
- CRITICAL: active damage, broken lights/reflectors, flat/damaged tire, major structural damage, fluid leaks, safety hazards
- WARNING: scratches, minor dents, surface rust, worn tire tread, dirty lights, debris
- OK: no visible issues

Keep issues array concise (max 5 items). If the angle doesn't show a problem area clearly, note that briefly.`

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
    }

    const body = await req.json()
    const { dataUrl, angleLabel } = body as { dataUrl: string; angleLabel: string }

    if (!dataUrl) {
      return NextResponse.json({ ok: false, error: 'Missing dataUrl' }, { status: 400 })
    }

    // Extract base64 data and media type from data URL
    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/)
    if (!match) {
      return NextResponse.json({ ok: false, error: 'Invalid dataUrl format' }, { status: 400 })
    }
    const mediaType = match[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    const base64Data = match[2]

    const message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data },
            },
            {
              type: 'text',
              text: `This is the "${angleLabel}" angle of a commercial trailer inspection. Analyze for any visible damage, defects, or issues.`,
            },
          ],
        },
      ],
    })

    const text = message.content[0].type === 'text' ? message.content[0].text : ''

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ ok: false, error: 'No JSON in AI response', raw: text }, { status: 500 })
    }

    const result = JSON.parse(jsonMatch[0])
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('analyze-photos error:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
