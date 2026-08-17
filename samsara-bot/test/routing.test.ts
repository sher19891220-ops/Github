import { describe, expect, it } from 'vitest';
import { parseUnitChatMap, resolveRoutes, routingKey } from '../src/routing';
import type { FleetAlert } from '../src/samsara/events';

const CENTRAL = '-1000000000000';

function alert(overrides: Partial<FleetAlert> = {}): FleetAlert {
  return {
    fingerprint: 'safety:1',
    behaviorKey: 'crash',
    title: 'Crash detected',
    emoji: '🚨',
    severity: 'critical',
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

describe('parseUnitChatMap', () => {
  it('parses a unit-to-chat object', () => {
    const map = parseUnitChatMap('{"Truck 12":"-1001","281":"-1002"}');
    expect(map.get('truck12')).toBe('-1001');
    expect(map.get('281')).toBe('-1002');
  });

  it('accepts numeric chat IDs', () => {
    expect(parseUnitChatMap('{"Truck 12":-1001}').get('truck12')).toBe('-1001');
  });

  it('returns an empty map for missing or invalid input', () => {
    expect(parseUnitChatMap(undefined).size).toBe(0);
    expect(parseUnitChatMap('not json').size).toBe(0);
    expect(parseUnitChatMap('["a"]').size).toBe(0);
  });

  it('skips entries whose chat ID is not a scalar', () => {
    const map = parseUnitChatMap('{"Truck 12":{"chat":"-1001"},"Truck 8":"-1002"}');
    expect(map.has('truck12')).toBe(false);
    expect(map.get('truck8')).toBe('-1002');
  });
});

describe('resolveRoutes', () => {
  const unitMap = parseUnitChatMap('{"Truck 12":"-1001","55":"-1002"}');

  it('always includes the central group', () => {
    const routes = resolveRoutes(alert(), { centralChatId: CENTRAL, unitMap: new Map() });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ chatId: CENTRAL, kind: 'central' });
  });

  it('adds the unit group when the vehicle name is mapped', () => {
    const routes = resolveRoutes(alert({ vehicle: 'Truck 12' }), {
      centralChatId: CENTRAL,
      unitMap,
    });
    expect(routes.map((route) => route.chatId)).toEqual([CENTRAL, '-1001']);
    expect(routes[1]?.kind).toBe('unit');
  });

  it('prefers the vehicle ID over the display name', () => {
    const routes = resolveRoutes(alert({ vehicleId: '55', vehicle: 'Truck 12' }), {
      centralChatId: CENTRAL,
      unitMap,
    });
    expect(routes.map((route) => route.chatId)).toEqual([CENTRAL, '-1002']);
  });

  it('falls back to the name when the ID is not mapped', () => {
    const routes = resolveRoutes(alert({ vehicleId: '999', vehicle: 'Truck 12' }), {
      centralChatId: CENTRAL,
      unitMap,
    });
    expect(routes.map((route) => route.chatId)).toEqual([CENTRAL, '-1001']);
  });

  it('does not double-send when the unit group is the central group', () => {
    const routes = resolveRoutes(alert({ vehicle: 'Truck 12' }), {
      centralChatId: '-1001',
      unitMap,
    });
    expect(routes).toHaveLength(1);
  });

  it('sends central-only for an unmapped vehicle', () => {
    const routes = resolveRoutes(alert({ vehicle: 'Truck 99' }), {
      centralChatId: CENTRAL,
      unitMap,
    });
    expect(routes).toHaveLength(1);
  });

  it('matches a name recorded with the #id fallback form', () => {
    const routes = resolveRoutes(alert({ vehicle: '#55' }), { centralChatId: CENTRAL, unitMap });
    expect(routes.map((route) => route.chatId)).toEqual([CENTRAL, '-1002']);
  });
});
