import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { InvalidTimeZoneError } from '@agile-tools/shared';
import { ForecastRequestSchema } from '@agile-tools/shared/contracts/forecast';

vi.mock('@/server/auth', () => ({
  requireWorkspaceContext: vi.fn(),
}));

vi.mock('@/server/request-security', () => ({
  assertTrustedMutationRequest: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock('@agile-tools/analytics', () => ({
  runWhenForecast: vi.fn(),
  runHowManyForecast: vi.fn(),
  DEFAULT_MONTE_CARLO_ITERATIONS: 1000,
  FORECAST_CACHE_TTL_HOURS: 24,
}));

vi.mock('@agile-tools/db', () => ({
  getPrismaClient: vi.fn(() => ({
    forecastResultCache: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  })),
  getFlowScope: vi.fn(),
  getLastSucceededSyncRun: vi.fn(),
  getSyncRunByDataVersion: vi.fn(),
  queryDailyThroughput: vi.fn(),
  computeForecastRequestHash: vi.fn(() => 'hash-1'),
  lookupForecastCache: vi.fn().mockResolvedValue(null),
  storeForecastCache: vi.fn(),
  formatDateInTimezone: vi.fn(),
}));

const { POST } = await import('./route');
const { requireWorkspaceContext } = await import('@/server/auth');
const {
  getFlowScope,
  getLastSucceededSyncRun,
  queryDailyThroughput,
  computeForecastRequestHash,
  storeForecastCache,
} = await import('@agile-tools/db');
const { runWhenForecast } = await import('@agile-tools/analytics');

describe('POST /api/v1/scopes/:scopeId/forecasts', () => {
  beforeEach(() => {
    vi.mocked(requireWorkspaceContext).mockResolvedValue({
      workspaceId: 'workspace-1',
      userId: 'user-1',
    } as never);
    vi.mocked(getFlowScope).mockResolvedValue({
      id: 'scope-1',
      workspaceId: 'workspace-1',
      timezone: 'UTC',
    } as never);
    vi.mocked(getLastSucceededSyncRun).mockResolvedValue({
      dataVersion: 'sync-1',
      finishedAt: new Date('2026-04-21T00:00:00Z'),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an actionable 409 when the scope timezone is invalid', async () => {
    vi.mocked(getFlowScope).mockResolvedValue({
      id: 'scope-1',
      workspaceId: 'workspace-1',
      timezone: 'ETC',
    } as never);
    vi.mocked(queryDailyThroughput).mockRejectedValue(new InvalidTimeZoneError('ETC'));

    const response = await POST(
      new NextRequest('http://localhost/api/v1/scopes/scope-1/forecasts', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'when',
          remainingStoryCount: 12,
          historicalWindowDays: 90,
          confidenceLevels: [85],
        }),
      }),
      { params: Promise.resolve({ scopeId: 'scope-1' }) },
    );

    expect(response.status).toBe(409);

    const body = await response.json();
    expect(body.code).toBe('INVALID_SCOPE_TIMEZONE');
    expect(body.message).toContain('ETC');
    expect(body.message).toContain('America/New_York');
  });

  it('returns 400 when how_many targetDate is not a real calendar date', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/v1/scopes/scope-1/forecasts', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'how_many',
          targetDate: '2025-02-30',
          historicalWindowDays: 90,
          confidenceLevels: [85],
        }),
      }),
      { params: Promise.resolve({ scopeId: 'scope-1' }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('targetDate: Must be a real calendar date in YYYY-MM-DD format.'),
      ]),
    );
  });

  it('excludes incomplete days from the forecast sample size', async () => {
    vi.mocked(queryDailyThroughput).mockResolvedValue([
      { day: '2026-04-19', completedStoryCount: 4, complete: true },
      { day: '2026-04-20', completedStoryCount: 3, complete: true },
      { day: '2026-04-21', completedStoryCount: 40, complete: false },
    ] as never);
    vi.mocked(runWhenForecast).mockReturnValue({
      warnings: [],
      results: [{ confidenceLevel: 85, completionDate: '2026-05-01' }],
    });

    const response = await POST(
      new NextRequest('http://localhost/api/v1/scopes/scope-1/forecasts', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'when',
          remainingStoryCount: 12,
          historicalWindowDays: 90,
          confidenceLevels: [85],
        }),
      }),
      { params: Promise.resolve({ scopeId: 'scope-1' }) },
    );

    expect(response.status).toBe(200);
    expect(runWhenForecast).toHaveBeenCalledWith(
      expect.objectContaining({
        historicalDailyThroughput: [4, 3],
        sampleSize: 7,
      }),
    );
    expect(storeForecastCache).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sampleWindow: expect.objectContaining({
          sampleMode: 'rolling',
          historicalWindowDays: 90,
          sampleStartDate: '2026-01-21',
          sampleEndDate: '2026-04-21',
        }),
        sampleSize: 7,
      }),
    );

    const body = await response.json();
    expect(body.sampleSize).toBe(7);
    expect(body.sampleMode).toBe('rolling');
    expect(body.sampleStartDate).toBe('2026-01-21');
  });

  it('uses explicit date ranges for sampling and cache identity', async () => {
    vi.mocked(queryDailyThroughput).mockResolvedValue([
      { day: '2026-02-02', completedStoryCount: 2, complete: true },
    ] as never);
    vi.mocked(runWhenForecast).mockReturnValue({
      warnings: [],
      results: [{ confidenceLevel: 85, completionDate: '2026-05-01' }],
    });

    const response = await POST(
      new NextRequest('http://localhost/api/v1/scopes/scope-1/forecasts', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'when',
          remainingStoryCount: 12,
          sampleMode: 'range',
          sampleStartDate: '2026-02-01',
          sampleEndDate: '2026-03-15',
          confidenceLevels: [85],
        }),
      }),
      { params: Promise.resolve({ scopeId: 'scope-1' }) },
    );

    expect(response.status).toBe(200);
    expect(computeForecastRequestHash).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleWindow: {
          sampleMode: 'range',
          sampleStartDate: '2026-02-01',
          sampleEndDate: '2026-03-15',
        },
      }),
    );
    expect(queryDailyThroughput).toHaveBeenCalledWith(
      expect.anything(),
      'scope-1',
      'UTC',
      expect.objectContaining({
        sampleStartDate: '2026-02-01',
        sampleEndDate: '2026-03-15',
      }),
    );

    const body = await response.json();
    expect(body.sampleMode).toBe('range');
    expect(body.historicalWindowDays).toBeUndefined();
    expect(body.sampleStartDate).toBe('2026-02-01');
  });

  it('rejects impossible dates at the shared forecast request schema boundary', () => {
    const parsed = ForecastRequestSchema.safeParse({
      type: 'how_many',
      targetDate: '2025-02-30',
      historicalWindowDays: 90,
      confidenceLevels: [85],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('real calendar date');
  });
});
