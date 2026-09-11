import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const client = new Anthropic()

// Builds a description of what the photo SHOULD show, based on the actual
// inspection type — never assume trailer. A truck photo analyzed under a
// trailer's expectations (or vice versa) produces nonsense results, so
// this is the single source of truth both prompts below are built from.
function describeVehicle(inspectionType?: string): { subject: string; expect: string } {
  const t = inspectionType || ''

  if (t.startsWith('TRUCK')) {
    return {
      subject: 'the TRACTOR (TRUCK) unit of a commercial semi',
      expect:
        'a cab, hood, grille, headlights, mirrors, fuel tanks, air tanks, steer and drive axles. ' +
        'This is NOT a trailer — there is no box, no rear cargo doors, and no trailer roof. ' +
        'Do not describe truck features (grille, hood, sleeper, exhaust stacks) as damage or as trailer parts.',
    }
  }
  if (t.includes('REEFER')) {
    return {
      subject: 'a REEFER (refrigerated) TRAILER',
      expect:
        'an enclosed box trailer with a refrigeration unit mounted on the front nose, insulated walls, ' +
        'rear cargo doors, and a sealed roof. Not a truck cab, not an open flatbed.',
    }
  }
  if (t.includes('FLATBED')) {
    return {
      subject: 'a FLATBED TRAILER',
      expect:
        'an OPEN deck trailer with NO walls, NO roof, and NO rear doors. Expect to see tarps, chains, ' +
        'straps, stake pockets, and a headboard — not an enclosed box. Do not flag "missing walls" or ' +
        '"missing doors" as damage; a flatbed never has them.',
    }
  }
  if (t.includes('STEPDECK')) {
    return {
      subject: 'a STEPDECK (drop deck) TRAILER',
      expect:
        'an OPEN deck trailer at two height levels, with NO walls, NO roof, and NO rear doors — similar ' +
        'to a flatbed but with a lower rear deck. Do not flag the absence of walls/doors as damage.',
    }
  }
  // Default: dry van, or trailer type not specified
  return {
    subject: 'a DRY VAN TRAILER',
    expect:
      'an enclosed box trailer with rear cargo doors, a solid roof, and side walls. Not a truck cab, ' +
      'not an open flatbed.',
  }
}

function buildSystemPrompt(inspectionType?: string): string {
  const { subject, expect } = describeVehicle(inspectionType)
  return `You are a commercial vehicle inspection AI reviewing ONE photo from an inspection of ${subject}.

What this photo SHOULD show: ${expect}

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
- MISMATCH CHECK (important, check this first): if the photo clearly shows a DIFFERENT kind of vehicle or trailer than described above — e.g. this was supposed to be a truck cab but the photo shows an enclosed trailer, or this was supposed to be a flatbed but the photo shows a box trailer — report this as CRITICAL with the issue "Photo does not match expected vehicle type" and explain the mismatch in "details". This is more important than typical damage checks, since it usually means the wrong unit was photographed.

Keep issues array concise (max 5 items). If the angle doesn't show a problem area clearly, note that briefly.`
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
    }

    const body = await req.json()
    const { dataUrl, angleLabel, inspectionType } = body as {
      dataUrl: string
      angleLabel: string
      inspectionType?: string
    }

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

    const { subject } = describeVehicle(inspectionType)

    const message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      system: buildSystemPrompt(inspectionType),
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
              text: `This is the "${angleLabel}" angle from an inspection of ${subject}. Analyze for any visible damage, defects, or issues — and first check whether this photo actually matches what a ${subject} should look like.`,
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
