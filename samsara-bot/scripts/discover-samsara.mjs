#!/usr/bin/env node
/**
 * Inventories what YOUR Samsara token can actually reach.
 *
 *   SAMSARA_API_TOKEN=... node scripts/discover-samsara.mjs
 *   SAMSARA_API_TOKEN=... node scripts/discover-samsara.mjs --json > samsara-capabilities.json
 *
 * The endpoint list below is a candidate catalogue drawn from Samsara's public
 * documentation. It is NOT authoritative for your organisation: entitlements,
 * token scopes and API versions all vary. The point of running it is to replace
 * assumptions with a measured list of what exists for you.
 *
 * Read-only. Every probe is a GET; write endpoints are listed but never called.
 *
 * Prints STATUS CODES, ROW COUNTS and FIELD NAMES only — never field values, no
 * vehicle or driver names, no coordinates. Output is safe to paste into a chat.
 * The token is read from the environment, not argv.
 *
 * Requires Node 18+. No dependencies.
 */

const TOKEN = process.env.SAMSARA_API_TOKEN;
const BASE = (process.env.SAMSARA_API_BASE ?? 'https://api.samsara.com').replace(/\/+$/, '');
const AS_JSON = process.argv.includes('--json');

if (!TOKEN) {
  console.error('SAMSARA_API_TOKEN is not set.');
  console.error('Usage: SAMSARA_API_TOKEN=... node scripts/discover-samsara.mjs');
  process.exit(2);
}

const now = new Date();
const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const timeRange = { startTime: iso(7 * DAY), endTime: iso(0) };

/** group → what building on it would enable. */
const CAPABILITIES = {
  identity: 'Know the org, its users and tags',
  fleet: 'Vehicles, trailers, assets and their live state',
  people: 'Drivers and their assignments',
  safety: 'Harsh events, crashes, phone use, seat belts, speeding',
  video: 'Dashcam clip retrieval',
  compliance: 'DVIRs, hours of service, violations',
  maintenance: 'Engine faults, DTCs, open issues',
  places: 'Addresses, geofences, routes',
  config: 'Webhooks and alert configuration',
};

const CATALOG = [
  { group: 'identity', name: 'org / me', path: '/me' },
  { group: 'identity', name: 'users', path: '/users', params: { limit: 1 } },
  { group: 'identity', name: 'tags', path: '/tags', params: { limit: 1 } },

  { group: 'fleet', name: 'vehicles', path: '/fleet/vehicles', params: { limit: 1 } },
  {
    group: 'fleet',
    name: 'vehicle stats',
    path: '/fleet/vehicles/stats',
    params: { types: 'gps,engineStates,fuelPercents,obdOdometerMeters' },
  },
  {
    group: 'fleet',
    name: 'vehicle stats history',
    path: '/fleet/vehicles/stats/history',
    params: { types: 'gps', ...timeRange },
  },
  { group: 'fleet', name: 'trailers', path: '/fleet/trailers', params: { limit: 1 } },
  { group: 'fleet', name: 'assets', path: '/assets', params: { limit: 1 } },
  { group: 'fleet', name: 'trips', path: '/fleet/trips', params: { ...timeRange } },

  { group: 'people', name: 'drivers', path: '/fleet/drivers', params: { limit: 1 } },
  {
    group: 'people',
    name: 'driver-vehicle assignments',
    path: '/fleet/driver-vehicle-assignments',
    params: { ...timeRange },
  },

  { group: 'safety', name: 'safety events', path: '/fleet/safety-events', params: { ...timeRange } },
  {
    group: 'safety',
    name: 'safety events (legacy v1)',
    path: '/v1/fleet/safety/events',
    params: { startMs: now.getTime() - 7 * DAY, endMs: now.getTime() },
  },
  {
    group: 'safety',
    name: 'incidents (workflows)',
    path: '/fleet/workflows/incidents',
    params: { ...timeRange },
    note: 'the path your alert deep-links use',
  },
  { group: 'safety', name: 'driver safety scores', path: '/fleet/drivers/safety/scores', params: { ...timeRange } },

  {
    group: 'video',
    name: 'media retrieval',
    path: '/cameras/media/retrieval',
    note: 'GET checks status; retrieval itself is a POST and is never called here',
  },

  { group: 'compliance', name: 'DVIRs', path: '/fleet/dvirs', params: { ...timeRange } },
  { group: 'compliance', name: 'HOS clocks', path: '/fleet/hos/clocks' },
  { group: 'compliance', name: 'HOS logs', path: '/fleet/hos/logs', params: { ...timeRange } },
  { group: 'compliance', name: 'HOS violations', path: '/fleet/hos/violations', params: { ...timeRange } },
  { group: 'compliance', name: 'HOS daily logs', path: '/fleet/hos/daily-logs', params: { ...timeRange } },

  { group: 'maintenance', name: 'engine fault codes', path: '/fleet/vehicles/fault-codes', params: { limit: 1 } },
  { group: 'maintenance', name: 'DVIR defects', path: '/fleet/defects', params: { ...timeRange } },
  { group: 'maintenance', name: 'issues', path: '/fleet/issues', params: { limit: 1 } },

  { group: 'places', name: 'addresses / geofences', path: '/addresses', params: { limit: 1 } },
  { group: 'places', name: 'routes', path: '/fleet/routes', params: { ...timeRange } },

  { group: 'config', name: 'webhooks', path: '/webhooks', note: 'shows what is wired up today' },
  { group: 'config', name: 'alert configurations', path: '/alerts/configurations', params: { limit: 1 } },
  { group: 'config', name: 'alert incidents', path: '/alerts/incidents', params: { ...timeRange } },
];

function buildUrl(path, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return `${BASE}${path}${query ? `?${query}` : ''}`;
}

/** Field names only, capped, so nothing identifying is printed. */
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? `[${shape(value[0], depth + 1)}]` : '[]';
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (depth >= 2) return `{${keys.slice(0, 8).join(',')}}`;
    return `{${keys.slice(0, 24).map((k) => `${k}:${shape(value[k], depth + 1)}`).join(', ')}}`;
  }
  return typeof value;
}

async function probe(entry) {
  let response;
  try {
    response = await fetch(buildUrl(entry.path, entry.params), {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    });
  } catch (error) {
    return { ...entry, ok: false, status: 0, verdict: 'network error', detail: error.message };
  }

  if (!response.ok) {
    const body = (await response.text()).split('\n')[0].slice(0, 160);
    const verdict =
      response.status === 404 ? 'not available on this API version' :
      response.status === 403 ? 'token lacks scope / not entitled' :
      response.status === 401 ? 'token invalid' :
      response.status === 400 ? 'reachable, but needs different parameters' :
      `HTTP ${response.status}`;
    return { ...entry, ok: false, status: response.status, verdict, detail: body };
  }

  const payload = await response.json();
  const rows = Array.isArray(payload.data) ? payload.data
    : Array.isArray(payload) ? payload
    : undefined;

  if (!rows) {
    return {
      ...entry, ok: true, status: 200, verdict: 'available',
      rows: null, fields: Object.keys(payload).slice(0, 24),
    };
  }
  return {
    ...entry, ok: true, status: 200, verdict: 'available',
    rows: rows.length,
    fields: rows.length ? Object.keys(rows[0]) : [],
    sampleShape: rows.length ? shape(rows[0]) : undefined,
    paginated: Boolean(payload.pagination),
  };
}

const results = [];
for (const entry of CATALOG) results.push(await probe(entry));

if (AS_JSON) {
  console.log(JSON.stringify({ base: BASE, probedAt: now.toISOString(), results }, null, 2));
  process.exit(0);
}

console.log(`Samsara capability discovery — ${BASE}`);
console.log(`Token ...${TOKEN.slice(-4)} · probed ${new Date().toISOString()}\n`);

for (const [group, description] of Object.entries(CAPABILITIES)) {
  const rows = results.filter((r) => r.group === group);
  if (!rows.length) continue;
  console.log(`\x1b[1m${group.toUpperCase()}\x1b[0m — ${description}`);
  for (const row of rows) {
    const mark = row.ok ? '✓' : '✗';
    const count = row.rows === null ? '' : row.rows === undefined ? '' : ` ${row.rows} row(s)`;
    console.log(`  ${mark} ${row.name.padEnd(28)} ${row.verdict}${count}`);
    if (row.note) console.log(`      note: ${row.note}`);
    if (row.ok && row.fields?.length) {
      console.log(`      fields: ${row.fields.join(', ')}`);
    }
    if (row.ok && row.rows === 0) {
      console.log('      (no rows in this window — fields unverified)');
    }
    if (!row.ok && row.detail) console.log(`      ${row.detail}`);
  }
  console.log('');
}

const available = results.filter((r) => r.ok);
const empty = available.filter((r) => r.rows === 0);
console.log('─'.repeat(72));
console.log(`Available: ${available.length}/${results.length}`);
console.log(`Blocked:   ${results.filter((r) => r.status === 403).length} scope · ${results.filter((r) => r.status === 404).length} not on this API version`);
if (empty.length) console.log(`Empty windows: ${empty.map((r) => r.name).join(', ')}`);
console.log('\nRe-run with --json to save a machine-readable capability map.');
