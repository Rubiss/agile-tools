import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { InvalidTimeZoneError } from '@agile-tools/shared';

vi.mock('@/server/auth', () => ({
  requireWorkspaceContext: vi.fn(),
}));

vi.mock('@agile-tools/db', () => ({
  getPrismaClient: vi.fn(() => ({})),
  getFlowScope: vi.fn(),
  getLastSucceededSyncRun: vi.fn(),
  getSyncRunByDataVersion: vi.fn(),
  queryDailyThroughput: vi.fn(),
}));

const { GET } = await import('./route');
const { requireWorkspaceContext } = await import('@/server/auth');
const {
  getFlowScope,
  getLastSucceededSyncRun,
  queryDailyThroughput,
} = await import('@agile-tools/db');

describe('GET /api/v1/scopes/:scopeId/throughput', () => {
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

    const response = await GET(
      new NextRequest('http://localhost/api/v1/scopes/scope-1/throughput'),
      { params: Promise.resolve({ scopeId: 'scope-1' }) },
    );

    expect(response.status).toBe(409);

    const body = await response.json();
    expect(body.code).toBe('INVALID_SCOPE_TIMEZONE');
    expect(body.message).toContain('ETC');
    expect(body.message).toContain('UTC');
  });

  it('excludes incomplete days from sampleSize while preserving the chart series', async () => {
    vi.mocked(queryDailyThroughput).mockResolvedValue([
      { day: '2026-04-19', completedStoryCount: 4, complete: true },
      { day: '2026-04-20', completedStoryCount: 3, complete: true },
      { day: '2026-04-21', completedStoryCount: 40, complete: false },
    ] as never);

    const response = await GET(
      new NextRequest('http://localhost/api/v1/scopes/scope-1/throughput'),
      { params: Promise.resolve({ scopeId: 'scope-1' }) },
    );

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.sampleMode).toBe('rolling');
    expect(body.historicalWindowDays).toBe(90);
    expect(body.sampleStartDate).toBe('2026-01-21');
    expect(body.sampleEndDate).toBe('2026-04-21');
    expect(body.sampleSize).toBe(7);
    expect(body.days).toEqual([
      { day: '2026-04-19', completedStoryCount: 4, complete: true },
      { day: '2026-04-20', completedStoryCount: 3, complete: true },
      { day: '2026-04-21', completedStoryCount: 40, complete: false },
    ]);
  });

  it('returns 400 for invalid throughput sample params', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/v1/scopes/scope-1/throughput?historicalWindowDays=-1'),
      { params: Promise.resolve({ scopeId: 'scope-1' }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.details).toEqual(
      expect.arrayContaining([expect.stringContaining('historicalWindowDays')]),
    );
  });

  it('passes explicit date ranges to the throughput projection', async () => {
    vi.mocked(queryDailyThroughput).mockResolvedValue([
      { day: '2026-02-02', completedStoryCount: 2, complete: true },
    ] as never);

    const response = await GET(
      new NextRequest(
        'http://localhost/api/v1/scopes/scope-1/throughput?sampleMode=range&sampleStartDate=2026-02-01&sampleEndDate=2026-03-15',
      ),
      { params: Promise.resolve({ scopeId: 'scope-1' }) },
    );

    expect(response.status).toBe(200);
    expect(queryDailyThroughput).toHaveBeenCalledWith(
      expect.anything(),
      'scope-1',
      'UTC',
      expect.objectContaining({
        sampleStartDate: '2026-02-01',
        sampleEndDate: '2026-03-15',
        dataVersion: 'sync-1',
      }),
    );

    const body = await response.json();
    expect(body.sampleMode).toBe('range');
    expect(body.historicalWindowDays).toBeUndefined();
    expect(body.sampleStartDate).toBe('2026-02-01');
    expect(body.sampleEndDate).toBe('2026-03-15');
  });
});
