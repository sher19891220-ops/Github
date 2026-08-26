import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { SETTING_KEYS, getSecret } from '@/server/settings';
import { pickMcNumber } from '@/server/fmcsa';

export const dynamic = 'force-dynamic';

const QC_BASE = 'https://mobile.fmcsa.dot.gov/qc/services/carriers';

interface Carrier {
  legalName?: string | null;
  dbaName?: string | null;
  dotNumber?: number | string | null;
  phyStreet?: string | null;
  phyCity?: string | null;
  phyState?: string | null;
  phyZipcode?: string | null;
  allowedToOperate?: string | null;
}

/**
 * Fetches the carrier's docket numbers.
 *
 * The MC number is not on the carrier record — QCMobile keeps docket numbers on
 * a separate resource, so reading `carrier.mcNumber` yields undefined for every
 * carrier and the field silently appears blank. A carrier may legitimately have
 * none, so a failure here is not a failure of the lookup.
 */
async function fetchMcNumber(usdot: string, key: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${QC_BASE}/${usdot}/docket-numbers?webKey=${encodeURIComponent(key)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!response.ok) return null;

    const json = (await response.json()) as { content?: unknown };
    return pickMcNumber(json.content);
  } catch {
    return null;
  }
}

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

  const key = await getSecret(await getDb(), SETTING_KEYS.fmcsaApiKey);
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
    const response = await fetch(`${QC_BASE}/${usdot}?webKey=${encodeURIComponent(key)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      // QCMobile answers an invalid web key with 404 rather than 401, which
      // otherwise reads as "no such carrier" and sends someone hunting for a
      // USDOT problem that does not exist. A genuinely unknown USDOT comes back
      // 200 with empty content, handled below — so a 404 here points at the key.
      const looksLikeBadKey = response.status === 404 || response.status === 401 || response.status === 403;
      return NextResponse.json(
        {
          error: looksLikeBadKey
            ? `FMCSA did not accept the request (HTTP ${response.status}). This usually means the configured web key is invalid or expired — check it under Settings → Integrations. If the key is known good, USDOT ${usdot} may not exist.`
            : `FMCSA returned ${response.status} for USDOT ${usdot}. Try again shortly, or enter the company details manually.`,
        },
        { status: 502 },
      );
    }

    const json = (await response.json()) as { content?: { carrier?: Carrier } | null };
    const carrier = json.content?.carrier;
    if (!carrier) {
      return NextResponse.json({ error: `No carrier found for USDOT ${usdot}.` }, { status: 404 });
    }

    const address = [carrier.phyStreet, carrier.phyCity, carrier.phyState, carrier.phyZipcode]
      .filter(Boolean)
      .join(', ');

    return NextResponse.json({
      company: {
        name: carrier.legalName ?? null,
        dba: carrier.dbaName ?? null,
        usdotNumber: String(carrier.dotNumber ?? usdot),
        mcNumber: await fetchMcNumber(usdot, key),
        address: address || null,
        // "allowedToOperate" is the operating authority flag; anything other
        // than an explicit Y means the carrier is not currently authorised.
        status: carrier.allowedToOperate === 'Y' ? 'active' : 'inactive',
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
