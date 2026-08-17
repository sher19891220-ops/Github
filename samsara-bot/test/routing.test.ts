import { describe, expect, it } from 'vitest';
import {
  candidateKeys,
  parseDestination,
  parseUnitChatMap,
  resolveRoutes,
  routingKey,
} from '../src/routing';
import type { FleetAlert } from '../src/samsara/events';

const CENTRAL = '-1002922384236';

/** The real label format seen in the Samsara Events group. */
const REAL_VEHICLE = '5269 (GZP5W69Z75) 281474991641331';

function alert(overrides: Partial<FleetAlert> = {}): FleetAlert {
  return {
    fingerprint: 'safety:1',
    behaviorKey: 'mobileUsage',
    title: 'Mobile phone usage',
    emoji: '📱',
    severity: 'high',
    details: [],
    links: [],
    videos: [],
    source: 'webhook',
    ...overrides,
  };
}

describe('routingKey', () => {
  it('ignores case, spacing and a leading hash', () => {
    expect(routingKey('Truck 12')).toBe('truck12');
    expect(routingKey('  TRUCK  12 ')).toBe('truck12');
    expect(routingKey('#281')).toBe('281');
  });
});

describe('candidateKeys', () => {
  it('splits the real "unit (plate) samsaraId" label into every identifier', () => {
    const keys = candidateKeys(alert({ vehicle: REAL_VEHICLE, vehicleId: '281474991641331' }));
    expect(keys).toContain('5269');
    expect(keys).toContain('gzp5w69z75');
    expect(keys).toContain('281474991641331');
  });

  it('puts the Samsara vehicle ID first', () => {
    const keys = candidateKeys(alert({ vehicle: REAL_VEHICLE, vehicleId: '281474991641331' }));
    expect(keys[0]).toBe('281474991641331');
  });

  it('de-duplicates repeated identifiers', () => {
    const keys = candidateKeys(alert({ vehicle: '5269', vehicleId: '5269' }));
    expect(keys).toEqual(['5269']);
  });

  it('copes with a plain name and with nothing at all', () => {
    expect(candidateKeys(alert({ vehicle: 'Truck 12' }))).toContain('truck12');
    expect(candidateKeys(alert())).toEqual([]);
  });
});

describe('parseDestination', () => {
  it('reads a bare chat ID', () => {
    expect(parseDestination('-1001234567890')).toEqual({ chatId: '-1001234567890' });
  });

  it('reads a chat ID with a forum topic', () => {
    expect(parseDestination('-1002922384236:42')).toEqual({
      chatId: '-1002922384236',
      threadId: 42,
    });
  });

  it('rejects a malformed topic rather than posting to the wrong place', () => {
    expect(parseDestination('-100123:abc')).toBeUndefined();
    expect(parseDestination('-100123:0')).toBeUndefined();
    expect(parseDestination('')).toBeUndefined();
  });
});

describe('parseUnitChatMap', () => {
  it('parses unit numbers and topics', () => {
    const map = parseUnitChatMap('{"5269":"-1001","1645":"-1002922384236:42"}');
    expect(map.get('5269')).toEqual({ chatId: '-1001' });
    expect(map.get('1645')).toEqual({ chatId: '-1002922384236', threadId: 42 });
  });

  it('accepts numeric chat IDs', () => {
    expect(parseUnitChatMap('{"5269":-1001}').get('5269')).toEqual({ chatId: '-1001' });
  });

  it('returns an empty map for missing or invalid input', () => {
    expect(parseUnitChatMap(undefined).size).toBe(0);
    expect(parseUnitChatMap('not json').size).toBe(0);
    expect(parseUnitChatMap('["a"]').size).toBe(0);
  });

  it('skips entries whose destination is not a scalar', () => {
    const map = parseUnitChatMap('{"5269":{"chat":"-1001"},"1645":"-1002"}');
    expect(map.has('5269')).toBe(false);
    expect(map.get('1645')).toEqual({ chatId: '-1002' });
  });
});

describe('resolveRoutes', () => {
  const unitMap = parseUnitChatMap(
    '{"5269":"-1001","1645":"-1002922384236:42","281474992211480":"-1003"}',
  );

  it('always includes the central group', () => {
    const routes = resolveRoutes(alert(), { centralChatId: CENTRAL, unitMap: new Map() });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ chatId: CENTRAL, kind: 'central' });
  });

  it('routes by unit number pulled out of the composite label', () => {
    const routes = resolveRoutes(alert({ vehicle: REAL_VEHICLE }), {
      centralChatId: CENTRAL,
      unitMap,
    });
    expect(routes.map((route) => route.chatId)).toEqual([CENTRAL, '-1001']);
    expect(routes[1]?.kind).toBe('unit');
  });

  it('routes to a forum topic when the map names one', () => {
    const routes = resolveRoutes(alert({ vehicle: '1645 (GCJDZ5Y8AR) 281475003958989' }), {
      centralChatId: CENTRAL,
      unitMap,
    });
    expect(routes[1]).toMatchObject({ chatId: '-1002922384236', threadId: 42 });
  });

  it('prefers the Samsara vehicle ID when it is the mapped key', () => {
    const routes = resolveRoutes(
      alert({ vehicle: '12878 (GPM5KEDZJ2) 281474992211480', vehicleId: '281474992211480' }),
      { centralChatId: CENTRAL, unitMap },
    );
    expect(routes.map((route) => route.chatId)).toEqual([CENTRAL, '-1003']);
  });

  it('does not double-send when the unit destination is the central one', () => {
    const routes = resolveRoutes(alert({ vehicle: REAL_VEHICLE }), {
      centralChatId: '-1001',
      unitMap,
    });
    expect(routes).toHaveLength(1);
  });

  it('treats a different topic in the central chat as a separate destination', () => {
    const routes = resolveRoutes(alert({ vehicle: '1645' }), {
      centralChatId: '-1002922384236',
      unitMap,
    });
    expect(routes).toHaveLength(2);
    expect(routes[1]?.threadId).toBe(42);
  });

  it('sends central-only for an unmapped unit', () => {
    const routes = resolveRoutes(alert({ vehicle: '9999 (ABC1234) 281474000000000' }), {
      centralChatId: CENTRAL,
      unitMap,
    });
    expect(routes).toHaveLength(1);
  });
});
