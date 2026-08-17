import { describe, expect, it } from 'vitest';
import { findBestMatch, isAllowedUser, parseCommand } from '../src/telegram/commands';

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/status')).toEqual({ name: 'status', args: '' });
  });

  it('strips the @botname suffix used in groups', () => {
    expect(parseCommand('/where@fleet_bot Truck 12')).toEqual({
      name: 'where',
      args: 'Truck 12',
    });
  });

  it('lowercases the command name and keeps argument case', () => {
    expect(parseCommand('/Vehicle ABC123')).toEqual({ name: 'vehicle', args: 'ABC123' });
  });

  it('ignores non-commands', () => {
    expect(parseCommand('hello there')).toBeUndefined();
    expect(parseCommand(undefined)).toBeUndefined();
    expect(parseCommand('/')).toBeUndefined();
  });
});

describe('isAllowedUser', () => {
  it('is open when no allow-list is configured', () => {
    expect(isAllowedUser(42, [])).toBe(true);
    expect(isAllowedUser(undefined, [])).toBe(true);
  });

  it('enforces the allow-list', () => {
    expect(isAllowedUser(42, ['42'])).toBe(true);
    expect(isAllowedUser(43, ['42'])).toBe(false);
    expect(isAllowedUser(undefined, ['42'])).toBe(false);
  });
});

describe('findBestMatch', () => {
  const vehicles = [
    { id: '1', name: 'Truck 12', vin: '1FUJGLDR9CSBF1234' },
    { id: '2', name: 'Truck 120', licensePlate: 'ABC1234' },
    { id: '3', name: 'Van 5' },
  ];

  it('prefers an exact name over a prefix', () => {
    expect(findBestMatch(vehicles, 'Truck 12')?.id).toBe('1');
  });

  it('matches on VIN and plate through the extra fields', () => {
    const byVin = findBestMatch(vehicles, '1FUJGLDR9CSBF1234', (v) => [v.vin, v.licensePlate]);
    expect(byVin?.id).toBe('1');
    const byPlate = findBestMatch(vehicles, 'abc1234', (v) => [v.vin, v.licensePlate]);
    expect(byPlate?.id).toBe('2');
  });

  it('matches on the Samsara ID', () => {
    expect(findBestMatch(vehicles, '3')?.id).toBe('3');
  });

  it('returns undefined when nothing matches', () => {
    expect(findBestMatch(vehicles, 'zzzz')).toBeUndefined();
    expect(findBestMatch(vehicles, '')).toBeUndefined();
  });
});
