import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/server/auth', () => ({
  requireWorkspaceContext: vi.fn(),
}));

vi.mock('@/server/request-security', () => ({
  assertTrustedMutationRequest: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock('@agile-tools/analytics', () => ({
  DEFAULT_MONTE_CARLO_ITERATIONS: 1000,
  runEpicForecast: vi.fn(),
}));

vi.mock('@agile-tools/db', () => ({
  formatDateInTimezone: vi.fn(() => '2026-06-01'),
  getFlowScope: vi.fn(),
  getJiraConnection: vi.fn(),
  getLastSucceededSyncRun: vi.fn(),
  getPrismaClient: vi.fn(() => ({})),
  getSyncRunByDataVersion: vi.fn(),
  listEpicForecastTargets: vi.fn(),
  queryDailyThroughput: vi.fn(),
  upsertEpicForecastTarget: vi.fn(),
}));

const { GET, POST } = await import('./route');
const { requireWorkspaceContext } = await import('@/server/auth');
const {
  getFlowScope,
  getJiraConnection,
  getLastSucceededSyncRun,
  getSyncRunByDataVersion,
  listEpicForecastTargets,
  queryDailyThroughput,
  upsertEpicForecastTarget,
} = await import('@agile-tools/db');
const { runEpicForecast } = await import('@agile-tools/analytics');

const scopeId = '00000000-0000-4000-8000-000000000003';
const activeTarget = {
  id: '00000000-0000-4000-8000-000000006001',
  scopeId,
  jiraIssueKey: 'AG-EPIC-1',
  summary: 'Checkout reliability hardening',
  dueDate: '2026-06-19',
  remainingStoryCount: 8,
  storyCountSource: 'epic_link',
  epicLinkStoryCount: 8,
  jiraStoryCount: 12,
  manualStoryCount: 10,
  status: 'active',
  closedAt: null,
  sortOrder: 1,
  createdAt: new Date('2026-06-01T10:00:00.000Z'),
  updatedAt: new Date('2026-06-01T10:00:00.000Z'),
};
const closedTarget = {
  ...activeTarget,
  id: '00000000-0000-4000-8000-000000006002',
  jiraIssueKey: 'AG-EPIC-0',
  summary: 'Legacy board clean-up',
  dueDate: '2026-05-20',
  status: 'closed',
  closedAt: new Date('2026-05-27T15:00:00.000Z'),
  sortOrder: 0,
};

describe('GET /api/v1/scopes/:scopeId/epic-forecasts', () => {
  beforeEach(() => {
    vi.mocked(requireWorkspaceContext).mockResolvedValue({
      workspaceId: 'workspace-1',
      userId: 'user-1',
    } as never);
    vi.mocked(getFlowScope).mockResolvedValue({
      id: scopeId,
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      timezone: 'UTC',
    } as never);
    vi.mocked(getJiraConnection).mockResolvedValue({
      id: 'connection-1',
      baseUrl: 'https://jira.local.example',
    } as never);
    vi.mocked(getLastSucceededSyncRun).mockResolvedValue({
      dataVersion: 'sync-1',
      finishedAt: new Date('2026-06-01T00:00:00.000Z'),
    } as never);
    vi.mocked(listEpicForecastTargets).mockResolvedValue([activeTarget, closedTarget] as never);
    vi.mocked(queryDailyThroughput).mockResolvedValue([
      { day: '2026-05-30', completedStoryCount: 4, complete: true },
      { day: '2026-05-31', completedStoryCount: 3, complete: true },
      { day: '2026-06-01', completedStoryCount: 40, complete: false },
    ] as never);
    vi.mocked(runEpicForecast).mockReturnValue({
      warnings: [],
      results: [
        {
          targetId: activeTarget.id,
          jiraIssueKey: activeTarget.jiraIssueKey,
          summary: activeTarget.summary,
          dueDate: activeTarget.dueDate,
          remainingStoryCount: activeTarget.remainingStoryCount,
          cumulativeStoryCount: 8,
          completionChance: 99.8,
          completionDatePercentiles: [
            { confidenceLevel: 50, completionDate: '2026-06-10' },
          ],
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 for invalid query params', async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/v1/scopes/${scopeId}/epic-forecasts?iterations=10`),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.details).toEqual(expect.arrayContaining([expect.stringContaining('iterations')]));
  });

  it('returns 404 when the Jira connection is missing', async () => {
    vi.mocked(getJiraConnection).mockResolvedValue(null);

    const response = await GET(
      new NextRequest(`http://localhost/api/v1/scopes/${scopeId}/epic-forecasts`),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.message).toBe('Jira connection not found.');
  });

  it('returns configured targets with a NO_DATA warning when no sync has succeeded', async () => {
    vi.mocked(getLastSucceededSyncRun).mockResolvedValue(null);

    const response = await GET(
      new NextRequest(`http://localhost/api/v1/scopes/${scopeId}/epic-forecasts`),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(200);
    expect(queryDailyThroughput).not.toHaveBeenCalled();
    expect(runEpicForecast).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body.dataVersion).toBe('');
    expect(body.warnings).toEqual([
      { code: 'NO_DATA', message: 'No synchronized data available yet.' },
    ]);
    expect(body.results).toEqual([]);
    expect(body.targets[0]).toMatchObject({
      jiraIssueKey: 'AG-EPIC-1',
      directUrl: 'https://jira.local.example/browse/AG-EPIC-1',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
  });

  it('advances stale but valid dataVersion pins to the latest retained projection', async () => {
    vi.mocked(getSyncRunByDataVersion).mockResolvedValue({
      dataVersion: 'old-sync',
      finishedAt: new Date('2026-05-30T00:00:00.000Z'),
    } as never);

    const response = await GET(
      new NextRequest(`http://localhost/api/v1/scopes/${scopeId}/epic-forecasts?dataVersion=old-sync`),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(200);
    expect(queryDailyThroughput).toHaveBeenCalledWith(
      expect.anything(),
      scopeId,
      'UTC',
      expect.objectContaining({ dataVersion: 'sync-1' }),
    );

    const body = await response.json();
    expect(body.dataVersion).toBe('sync-1');
  });

  it('runs the sequential epic forecast against active targets only', async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/v1/scopes/${scopeId}/epic-forecasts?historicalWindowDays=90`),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(200);
    expect(runEpicForecast).toHaveBeenCalledWith(
      expect.objectContaining({
        historicalDailyThroughput: [4, 3],
        sampleSize: 7,
        iterations: 1000,
        confidenceLevels: [50, 70, 85, 95],
        timezone: 'UTC',
        targets: [
          expect.objectContaining({
            id: activeTarget.id,
            jiraIssueKey: 'AG-EPIC-1',
            remainingStoryCount: 8,
          }),
        ],
      }),
    );

    const body = await response.json();
    expect(body.sampleSize).toBe(7);
    expect(body.targets).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      jiraIssueKey: 'AG-EPIC-1',
      completionChance: 99.8,
    });
  });
});

describe('POST /api/v1/scopes/:scopeId/epic-forecasts', () => {
  beforeEach(() => {
    vi.mocked(requireWorkspaceContext).mockResolvedValue({
      workspaceId: 'workspace-1',
      userId: 'user-1',
    } as never);
    vi.mocked(getFlowScope).mockResolvedValue({
      id: scopeId,
      workspaceId: 'workspace-1',
      connectionId: 'connection-1',
      timezone: 'UTC',
    } as never);
    vi.mocked(getJiraConnection).mockResolvedValue({
      id: 'connection-1',
      baseUrl: 'https://jira.local.example',
    } as never);
    vi.mocked(listEpicForecastTargets).mockResolvedValue([activeTarget] as never);
    vi.mocked(upsertEpicForecastTarget).mockResolvedValue(activeTarget as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 for invalid request bodies', async () => {
    const response = await POST(
      new NextRequest(`http://localhost/api/v1/scopes/${scopeId}/epic-forecasts`, {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jiraIssueKey: '' }),
      }),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INVALID_REQUEST');
  });

  it('saves a target and appends a sort order when no order is provided', async () => {
    const response = await POST(
      new NextRequest(`http://localhost/api/v1/scopes/${scopeId}/epic-forecasts`, {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jiraIssueKey: 'ag-epic-2',
          summary: 'Flow forecasting dashboard rollout',
          dueDate: '2026-07-03',
          remainingStoryCount: 28,
        }),
      }),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(201);
    expect(upsertEpicForecastTarget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jiraIssueKey: 'AG-EPIC-2',
        summary: 'Flow forecasting dashboard rollout',
        sortOrder: 2,
      }),
    );
  });
});
