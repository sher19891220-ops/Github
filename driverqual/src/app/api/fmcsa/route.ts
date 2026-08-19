import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { SETTING_KEYS, getSecret } from '@/server/settings';

export const dynamic = 'force-dynamic';

/**
 * USDOT lookup against the FMCSA QCMobile API. When the integration is not
 * configured, this reports that plainly so the operator can type the details in
 * — it never returns placeholder company data.
 */
export async function GET(request: Request) {
  const usdot = new URL(request.url).searchParams.get('usdot')?.trim();
  if (!usdot || !/^\d{1,8}$/.test(usdot)) {
    return NextResponse.json({ error: 'Enter a numeric USDOT number.' }, { status: 400 });
  }

  const key = getSecret(getDb(), SETTING_KEYS.fmcsaApiKey);
  if (!key) {
    return NextResponse.json(
      {
        error:
          'The FMCSA lookup is not configured. Add an FMCSA web key under Settings → Integrations, or enter the company details manually.',
        configured: false,
      },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(
      `https://mobile.fmcsa.dot.gov/qc/services/carriers/${usdot}?webKey=${encodeURIComponent(key)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!response.ok) {
      return NextResponse.json(
        { error: `FMCSA returned ${response.status} for USDOT ${usdot}.` },
        { status: 502 },
      );
    }
    const json = (await response.json()) as { content?: { carrier?: Record<string, unknown> } };
    const carrier = json.content?.carrier;
    if (!carrier) {
      return NextResponse.json({ error: `No carrier found for USDOT ${usdot}.` }, { status: 404 });
    }

    return NextResponse.json({
      company: {
        name: carrier['legalName'] ?? null,
        dba: carrier['dbaName'] ?? null,
        usdotNumber: String(carrier['dotNumber'] ?? usdot),
        mcNumber: carrier['mcNumber'] ?? null,
        address: [
          carrier['phyStreet'],
          carrier['phyCity'],
          carrier['phyState'],
          carrier['phyZipcode'],
        ]
          .filter(Boolean)
          .join(', '),
        status: carrier['allowedToOperate'] === 'Y' ? 'active' : 'inactive',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: `Could not reach FMCSA: ${error instanceof Error ? error.message : String(error)}. Enter the company details manually.`,
      },
      { status: 502 },
    );
  }
}
