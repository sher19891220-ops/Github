import { describe, expect, it, vi } from 'vitest';
import { SamsaraClient, SamsaraError } from '../src/samsara/client';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetchImpl: typeof fetch, overrides = {}): SamsaraClient {
  return new SamsaraClient({
    baseUrl: 'https://api.test',
    token: 'test-token',
    fetchImpl,
    maxRetries: 2,
    ...overrides,
  });
}

describe('SamsaraClient.request', () => {
  it('sends the bearer token and builds the query string', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    await client(fetchImpl as unknown as typeof fetch).request('/fleet/vehicles', {
      limit: 10,
      types: ['gps', 'engineStates'],
      skipped: undefined,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/fleet/vehicles?limit=10&types=gps%2CengineStates');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
  });

  it('throws immediately on a 4xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'nope' }, 403));
    await expect(
      client(fetchImpl as unknown as typeof fetch).request('/fleet/vehicles'),
    ).rejects.toBeInstanceOf(SamsaraError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces the Samsara message and requestId on an error', async () => {
    // Exactly the envelope api.samsara.com returns for a bad token.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: 'invalid token', requestId: 'blyieapo-nkfhthue' }, 401),
    );

    const error = await client(fetchImpl as unknown as typeof fetch)
      .request('/fleet/vehicles')
      .catch((err: unknown) => err as SamsaraError);

    expect(error).toBeInstanceOf(SamsaraError);
    expect((error as SamsaraError).status).toBe(401);
    expect((error as SamsaraError).requestId).toBe('blyieapo-nkfhthue');
    expect((error as SamsaraError).message).toContain('invalid token');
    expect((error as SamsaraError).message).toContain('blyieapo-nkfhthue');
  });

  it('tolerates a non-JSON error body', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>gateway</html>', { status: 502 }));
    await expect(
      client(fetchImpl as unknown as typeof fetch, { maxRetries: 0 }).request('/fleet/vehicles'),
    ).rejects.toThrow(/returned 502/);
  });

  it('retries a 429 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: '1' }] }));

    const result = await client(fetchImpl as unknown as typeof fetch).request<{
      data: { id: string }[];
    }>('/fleet/vehicles');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.data).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    await expect(
      client(fetchImpl as unknown as typeof fetch, { maxRetries: 1 }).request('/fleet/vehicles'),
    ).rejects.toThrow(/returned 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries network errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    await expect(
      client(fetchImpl as unknown as typeof fetch).request('/fleet/vehicles'),
    ).resolves.toEqual({ data: [] });
  });
});

describe('SamsaraClient.paginate', () => {
  it('follows the cursor until hasNextPage is false', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: '1' }],
          pagination: { hasNextPage: true, endCursor: 'cursor-1' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: '2' }], pagination: { hasNextPage: false } }),
      );

    const items = await client(fetchImpl as unknown as typeof fetch).paginate<{ id: string }>(
      '/fleet/vehicles',
    );

    expect(items.map((item) => item.id)).toEqual(['1', '2']);
    const secondUrl = (fetchImpl.mock.calls[1] as unknown as [string])[0];
    expect(secondUrl).toContain('after=cursor-1');
  });

  it('stops at the page cap instead of looping forever', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'x' }], pagination: { hasNextPage: true, endCursor: 'c' } }),
    );

    const items = await client(fetchImpl as unknown as typeof fetch, { maxPages: 3 }).paginate(
      '/fleet/vehicles',
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(items).toHaveLength(3);
  });

  it('tolerates a response with no data array', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(
      client(fetchImpl as unknown as typeof fetch).paginate('/fleet/vehicles'),
    ).resolves.toEqual([]);
  });
});
