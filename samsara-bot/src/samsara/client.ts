import { config } from '../config';
import { log } from '../logger';
import type {
  Driver,
  Dvir,
  HosClock,
  HosViolation,
  Paginated,
  SafetyEvent,
  Vehicle,
  VehicleStats,
} from './types';

/**
 * Endpoint paths, kept in one place so a Samsara API change is a one-line fix.
 * Reference: https://developers.samsara.com/reference
 */
export const ENDPOINTS = {
  vehicles: '/fleet/vehicles',
  vehicleStats: '/fleet/vehicles/stats',
  drivers: '/fleet/drivers',
  safetyEvents: '/fleet/safety-events',
  dvirs: '/fleet/dvirs',
  hosClocks: '/fleet/hos/clocks',
  hosViolations: '/fleet/hos/violations',
} as const;

export class SamsaraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'SamsaraError';
  }
}

type QueryValue = string | number | boolean | undefined | null | string[];

function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export interface SamsaraClientOptions {
  baseUrl?: string;
  token?: string;
  /** Retries for 429/5xx responses. */
  maxRetries?: number;
  /** Safety valve so one call can never walk an unbounded number of pages. */
  maxPages?: number;
  fetchImpl?: typeof fetch;
}

export class SamsaraClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly maxRetries: number;
  private readonly maxPages: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SamsaraClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? config.samsaraBaseUrl).replace(/\/+$/, '');
    this.token = options.token ?? config.samsaraToken;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxPages = options.maxPages ?? 20;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(params)}`;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
          },
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await this.backoff(attempt);
        continue;
      }

      if (response.ok) return (await response.json()) as T;

      const body = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new SamsaraError(
        `Samsara ${path} returned ${response.status}`,
        response.status,
        body.slice(0, 500),
      );
      if (!retryable || attempt === this.maxRetries) throw lastError;

      const retryAfter = Number(response.headers.get('retry-after'));
      await this.backoff(attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
    }

    throw lastError ?? new Error(`Samsara ${path} failed`);
  }

  private async backoff(attempt: number, overrideMs?: number): Promise<void> {
    const delay = overrideMs ?? Math.min(8000, 2 ** attempt * 250) + Math.floor(Math.random() * 100);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /** Walks Samsara's cursor pagination and concatenates `data`. */
  async paginate<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T[]> {
    const items: T[] = [];
    let after: string | undefined;

    for (let page = 0; page < this.maxPages; page += 1) {
      const response = await this.request<Paginated<T>>(path, { ...params, after });
      items.push(...(response.data ?? []));
      if (!response.pagination?.hasNextPage || !response.pagination.endCursor) return items;
      after = response.pagination.endCursor;
    }

    log.warn('Stopped paginating at the page cap', { path, maxPages: this.maxPages });
    return items;
  }

  listVehicles(limit = 512): Promise<Vehicle[]> {
    return this.paginate<Vehicle>(ENDPOINTS.vehicles, { limit });
  }

  listDrivers(limit = 512): Promise<Driver[]> {
    return this.paginate<Driver>(ENDPOINTS.drivers, { limit, driverActivationStatus: 'active' });
  }

  /**
   * Latest snapshot per vehicle. `types` is a comma list such as
   * `gps,engineStates,fuelPercents,obdOdometerMeters`.
   */
  listVehicleStats(types: string[], vehicleIds?: string[]): Promise<VehicleStats[]> {
    return this.paginate<VehicleStats>(ENDPOINTS.vehicleStats, {
      types,
      ...(vehicleIds?.length ? { vehicleIds } : {}),
    });
  }

  listSafetyEvents(startTime: Date, endTime: Date): Promise<SafetyEvent[]> {
    return this.paginate<SafetyEvent>(ENDPOINTS.safetyEvents, {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    });
  }

  listDvirs(startTime: Date, endTime: Date): Promise<Dvir[]> {
    return this.paginate<Dvir>(ENDPOINTS.dvirs, {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    });
  }

  listHosClocks(driverIds?: string[]): Promise<HosClock[]> {
    return this.paginate<HosClock>(ENDPOINTS.hosClocks, {
      ...(driverIds?.length ? { driverIds } : {}),
    });
  }

  listHosViolations(startTime: Date, endTime: Date): Promise<HosViolation[]> {
    return this.paginate<HosViolation>(ENDPOINTS.hosViolations, {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    });
  }
}

let cached: SamsaraClient | undefined;

export function getSamsaraClient(): SamsaraClient {
  if (!cached) cached = new SamsaraClient();
  return cached;
}

/** Test seam. */
export function resetSamsaraClient(): void {
  cached = undefined;
}
