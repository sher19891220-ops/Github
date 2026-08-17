#!/usr/bin/env node
/**
 * Probes every Samsara endpoint this bot depends on and reports what actually
 * came back, so the guesses in src/samsara/client.ts can be replaced with facts.
 *
 *   SAMSARA_API_TOKEN=... node scripts/verify-samsara.mjs
 *
 * Deliberately prints only STATUS CODES and FIELD NAMES — never field values,
 * vehicle names, driver names or coordinates. The output is safe to paste into
 * a chat or an issue. The token is read from the environment, not argv, so it
 * stays out of shell history and process listings.
 *
 * Requires Node 18+ (global fetch). No dependencies.
 */

const TOKEN = process.env.SAMSARA_API_TOKEN;
const BASE = (process.env.SAMSARA_API_BASE ?? 'https://api.samsara.com').replace(/\/+$/, '');

if (!TOKEN) {
  console.error('SAMSARA_API_TOKEN is not set.');
  console.error('Usage: SAMSARA_API_TOKEN=... node scripts/verify-samsara.mjs');
  process.exit(2);
}

const now = new Date();
const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

/** Each probe: what the bot calls, and which fields it reads off the response. */
const PROBES = [
  {
    name: 'vehicles',
    path: '/fleet/vehicles',
    params: { limit: 1 },
    required: true,
    expects: ['id', 'name'],
    usedBy: '/status, /vehicle, /where, PTI missing-inspection check',
  },
  {
    name: 'vehicle stats',
    path: '/fleet/vehicles/stats',
    params: { types: 'gps,engineStates,fuelPercents,obdOdometerMeters' },
    required: true,
    expects: ['gps', 'engineStates', 'obdOdometerMeters'],
    usedBy: '/status, /vehicle, /where, daily digest',
  },
  {
    name: 'drivers',
    path: '/fleet/drivers',
    params: { limit: 1 },
    required: true,
    expects: ['id', 'name'],
    usedBy: '/driver, /status',
  },
  {
    name: 'safety events',
    path: '/fleet/safety-events',
    params: { startTime: dayAgo.toISOString(), endTime: now.toISOString() },
    required: true,
    expects: ['time', 'vehicle', 'behaviorLabels'],
    usedBy: 'safety poller, /safety, daily digest',
  },
  {
    name: 'DVIRs',
    path: '/fleet/dvirs',
    params: { startTime: weekAgo.toISOString(), endTime: now.toISOString() },
    required: true,
    expects: ['safetyStatus', 'inspectionType', 'defects'],
    usedBy: 'PTI/DVIR report, /pti',
  },
  {
    name: 'HOS clocks',
    path: '/fleet/hos/clocks',
    params: {},
    required: false,
    expects: ['driver', 'clocks'],
    usedBy: '/hos, /driver',
  },
  {
    name: 'HOS violations',
    path: '/fleet/hos/violations',
    params: { startTime: weekAgo.toISOString(), endTime: now.toISOString() },
    required: false,
    expects: ['driver', 'violationType'],
    usedBy: 'daily digest',
  },
];

function buildUrl(path, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return `${BASE}${path}${query ? `?${query}` : ''}`;
}

/** Field names only, one level deep, so nothing identifying is printed. */
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? `[${shape(value[0], depth + 1)}]` : '[]';
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (depth >= 1) return `{${keys.slice(0, 12).join(', ')}}`;
    return `{\n      ${keys.map((key) => `${key}: ${shape(value[key], depth + 1)}`).join(',\n      ')}\n    }`;
  }
  return typeof value;
}

async function probe(entry) {
  const url = buildUrl(entry.path, entry.params);
  const label = `${entry.name.padEnd(16)} ${entry.path}`;

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    });
  } catch (error) {
    console.log(`✗ ${label}\n    network error: ${error.message}`);
    return { ok: false, entry };
  }

  if (!response.ok) {
    const body = await response.text();
    // Error bodies can echo the request; show only the first line, capped.
    const hint = body.split('\n')[0].slice(0, 200);
    console.log(`✗ ${label}\n    HTTP ${response.status} — ${hint}`);
    if (response.status === 404) console.log('    → endpoint path is wrong for this org');
    if (response.status === 401) console.log('    → token is invalid');
    if (response.status === 403) console.log('    → token lacks the scope for this endpoint');
    return { ok: false, entry, status: response.status };
  }

  const payload = await response.json();
  const rows = Array.isArray(payload.data) ? payload.data : undefined;

  console.log(`✓ ${label}  HTTP 200`);

  if (!rows) {
    console.log(`    ⚠ no top-level "data" array; top-level keys: ${Object.keys(payload).join(', ')}`);
    return { ok: true, entry, warned: true };
  }

  const pagination = payload.pagination
    ? `pagination: {${Object.keys(payload.pagination).join(', ')}}`
    : '⚠ no pagination object';
  console.log(`    rows: ${rows.length}   ${pagination}`);

  if (rows.length === 0) {
    console.log('    (no rows in this window — field names unverified)');
    return { ok: true, entry, empty: true };
  }

  console.log(`    first row: ${shape(rows[0])}`);

  const present = new Set(Object.keys(rows[0]));
  const missing = entry.expects.filter((field) => !present.has(field));
  if (missing.length) {
    console.log(`    ⚠ bot reads these, but they are absent: ${missing.join(', ')}`);
    console.log(`      (used by: ${entry.usedBy})`);
  }
  return { ok: true, entry, missing };
}

console.log(`Samsara API probe — ${BASE}`);
console.log(`Token: ...${TOKEN.slice(-4)}  (only the last 4 characters are shown)\n`);

const results = [];
for (const entry of PROBES) {
  results.push(await probe(entry));
  console.log('');
}

const failedRequired = results.filter((r) => !r.ok && r.entry.required);
const failedOptional = results.filter((r) => !r.ok && !r.entry.required);
const fieldGaps = results.filter((r) => r.missing?.length);
const empty = results.filter((r) => r.empty);

console.log('─'.repeat(70));
console.log(`Reachable:        ${results.filter((r) => r.ok).length}/${results.length}`);
if (failedRequired.length) {
  console.log(`Failed (blocking): ${failedRequired.map((r) => r.entry.name).join(', ')}`);
}
if (failedOptional.length) {
  console.log(`Failed (degrades): ${failedOptional.map((r) => r.entry.name).join(', ')}`);
}
if (fieldGaps.length) {
  console.log(`Field mismatches:  ${fieldGaps.map((r) => r.entry.name).join(', ')}`);
}
if (empty.length) {
  console.log(`Empty windows:     ${empty.map((r) => r.entry.name).join(', ')} (re-run over a busier period)`);
}
if (!failedRequired.length && !fieldGaps.length) {
  console.log('\nEvery endpoint and field the bot depends on checks out.');
}

process.exit(failedRequired.length ? 1 : 0);
