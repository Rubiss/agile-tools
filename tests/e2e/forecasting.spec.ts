/**
 * E2E tests for the forecasting page and API routes.
 *
 * Prerequisites:
 *  - PLAYWRIGHT_BASE_URL (defaults to http://localhost:3000)
 *  - DATABASE_URL pointing to a running Postgres
 *  - ENCRYPTION_KEY env var (at least 32 characters)
 *  - The Next.js dev server must be running
 *
 * Strategy:
 *  - The forecast page (`/scopes/:scopeId/forecast`) is a client component.
 *    Throughput and forecast data are loaded client-side after mount.
 *  - page.route() mocks are used for browser-initiated API calls so tests
 *    run without a full synced Jira dataset.
 *  - The final test exercises the real POST /forecasts route (no mock) using
 *    page.request.post() with the admin cookie to verify the server-side
 *    forecast path end-to-end.
 */

import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@agile-tools/db';
import { encryptSecret } from '@agile-tools/shared';
import type { ThroughputResponse } from '@agile-tools/shared/contracts/api';
import type { ForecastResponse } from '@agile-tools/shared/contracts/forecast';
import { serializeWorkspaceContext } from '../../apps/web/src/server/session-cookie';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ENCRYPTION_KEY =
  process.env['ENCRYPTION_KEY'] ?? 'test-encryption-key-32-chars-ok!';
const SESSION_SECRET =
  process.env['SESSION_SECRET'] ?? 'playwright-session-secret-1234567890';
const JIRA_BASE = 'https://jira.example.internal';

process.env['SESSION_SECRET'] = SESSION_SECRET;

let db: PrismaClient;
let workspaceId: string;
let connectionId: string;
let scopeId: string;
let syncRunId: string;
let adminCookie: string;

/**
 * Mock ThroughputResponse with realistic daily data so the chart renders.
 * Sample size < FORECAST_MIN_SAMPLE_SIZE (60) to exercise LOW_SAMPLE_SIZE path.
 */
const MOCK_THROUGHPUT: ThroughputResponse = {
  scopeId: '', // filled in after scopeId is known
  dataVersion: 'forecast-e2e-version',
  syncedAt: new Date('2025-01-15T12:00:00Z').toISOString(),
  sampleMode: 'rolling',
  historicalWindowDays: 90,
  sampleStartDate: '2024-10-17',
  sampleEndDate: '2025-01-15',
  sampleSize: 15,
  warnings: [],
  days: [
    { day: '2025-01-05', completedStoryCount: 2, complete: true },
    { day: '2025-01-06', completedStoryCount: 0, complete: true },
    { day: '2025-01-07', completedStoryCount: 3, complete: true },
    { day: '2025-01-08', completedStoryCount: 1, complete: true },
    { day: '2025-01-09', completedStoryCount: 0, complete: true },
    { day: '2025-01-10', completedStoryCount: 2, complete: true },
    { day: '2025-01-11', completedStoryCount: 1, complete: true },
    { day: '2025-01-12', completedStoryCount: 0, complete: true },
    { day: '2025-01-13', completedStoryCount: 3, complete: true },
    { day: '2025-01-14', completedStoryCount: 1, complete: true },
    { day: '2025-01-15', completedStoryCount: 2, complete: false },
  ],
};

/** Mock ForecastResponse for a 'when' forecast. */
const MOCK_WHEN_RESPONSE: ForecastResponse = {
  scopeId: '', // filled in after scopeId is known
  dataVersion: 'forecast-e2e-version',
  type: 'when',
  sampleMode: 'rolling',
  historicalWindowDays: 90,
  sampleStartDate: '2024-10-17',
  sampleEndDate: '2025-01-15',
  sampleSize: 15,
  iterations: 10000,
  warnings: [
    {
      code: 'LOW_SAMPLE_SIZE',
      message:
        'Only 15 completed stories in the historical window. At least 60 are recommended for reliable forecasts.',
    },
  ],
  results: [
    { confidenceLevel: 50, completionDate: '2025-03-10' },
    { confidenceLevel: 70, completionDate: '2025-03-17' },
    { confidenceLevel: 85, completionDate: '2025-03-24' },
    { confidenceLevel: 95, completionDate: '2025-04-07' },
  ],
};

/** Mock ForecastResponse for a 'how_many' forecast. */
const MOCK_HOW_MANY_RESPONSE: ForecastResponse = {
  scopeId: '', // filled in after scopeId is known
  dataVersion: 'forecast-e2e-version',
  type: 'how_many',
  sampleMode: 'rolling',
  historicalWindowDays: 90,
  sampleStartDate: '2024-10-17',
  sampleEndDate: '2025-01-15',
  sampleSize: 15,
  iterations: 10000,
  warnings: [
    {
      code: 'LOW_SAMPLE_SIZE',
      message:
        'Only 15 completed stories in the historical window. At least 60 are recommended for reliable forecasts.',
    },
  ],
  results: [
    { confidenceLevel: 50, completedStoryCount: 12 },
    { confidenceLevel: 70, completedStoryCount: 9 },
    { confidenceLevel: 85, completedStoryCount: 7 },
    { confidenceLevel: 95, completedStoryCount: 4 },
  ],
};

test.beforeAll(async () => {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for E2E tests. Start docker-compose first.');
  }

  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  const workspace = await db.workspace.create({
    data: { name: 'Forecasting E2E Workspace', defaultTimezone: 'UTC' },
  });
  workspaceId = workspace.id;

  const encryptedSecretRef = encryptSecret('e2e-pat', ENCRYPTION_KEY);
  const connection = await db.jiraConnection.create({
    data: {
      workspaceId,
      baseUrl: JIRA_BASE,
      displayName: 'Forecast E2E Connection',
      authType: 'pat',
      encryptedSecretRef,
      healthStatus: 'healthy',
    },
  });
  connectionId = connection.id;

  const scope = await db.flowScope.create({
    data: {
      workspaceId,
      connectionId,
      boardId: '50',
      boardName: 'Forecast E2E Board',
      timezone: 'UTC',
      includedIssueTypeIds: ['story'],
      startStatusIds: ['10'],
      doneStatusIds: ['30'],
      syncIntervalMinutes: 10,
    },
  });
  scopeId = scope.id;

  // Create a succeeded SyncRun with a dataVersion so the forecast route resolves it.
  const syncRun = await db.syncRun.create({
    data: {
      scopeId,
      trigger: 'manual',
      status: 'succeeded',
      startedAt: new Date('2025-01-01T00:00:00Z'),
      finishedAt: new Date('2025-01-15T12:00:00Z'),
      dataVersion: 'forecast-e2e-version',
    },
  });
  syncRunId = syncRun.id;

  // Seed completed work items so the real POST /forecasts route has throughput data.
  // Using noon UTC timestamps spread over the last 20 days to produce valid history.
  const now = new Date();
  const completedItems = Array.from({ length: 10 }, (_, i) => {
    const completedNoon = new Date(now.getTime() - (i + 2) * 2 * 24 * 60 * 60 * 1000);
    completedNoon.setUTCHours(12, 0, 0, 0);
    const startedNoon = new Date(completedNoon.getTime() - 5 * 24 * 60 * 60 * 1000);
    return {
      scopeId,
      lastSyncRunId: syncRunId,
      jiraIssueId: `FC-${i + 1}`,
      issueKey: `FC-${i + 1}`,
      summary: `Completed story ${i + 1}`,
      issueTypeId: 'story',
      issueTypeName: 'Story',
      projectId: 'FC',
      currentStatusId: '30',
      currentColumn: 'Done',
      directUrl: `${JIRA_BASE}/browse/FC-${i + 1}`,
      createdAt: startedNoon,
      startedAt: startedNoon,
      completedAt: completedNoon,
    };
  });
  await db.workItem.createMany({ data: completedItems });

  adminCookie = serializeWorkspaceContext({
    userId: 'e2e-forecast-user',
    workspaceId,
    role: 'admin',
  });
});

test.afterAll(async () => {
  if (!db) return;
  await db.workItem.deleteMany({ where: { scopeId } });
  await db.syncRun.deleteMany({ where: { id: syncRunId } });
  await db.flowScope.deleteMany({ where: { id: scopeId } });
  await db.jiraConnection.deleteMany({ where: { id: connectionId } });
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.$disconnect();
});

async function setAdminSession(page: Page) {
  const baseUrl = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000';
  await page.context().addCookies([
    {
      name: 'agile_session',
      value: adminCookie,
      url: baseUrl,
    },
  ]);
}

/** Intercept the browser-side GET /throughput request. */
async function mockThroughputApi(page: Page) {
  const response: ThroughputResponse = { ...MOCK_THROUGHPUT, scopeId };
  await page.route(`**/api/v1/scopes/${scopeId}/throughput**`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}

/** Intercept the browser-side POST /forecasts request and return the given mock. */
async function mockForecastApi(page: Page, mockResponse: ForecastResponse) {
  const response: ForecastResponse = { ...mockResponse, scopeId };
  await page.route(`**/api/v1/scopes/${scopeId}/forecasts**`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}

// ─── Test: Forecast page loads with throughput chart ─────────────────────────

test('forecast page loads and renders throughput chart', async ({ page }) => {
  await setAdminSession(page);
  await mockThroughputApi(page);

  await page.goto(`/scopes/${scopeId}/forecast`);

  // Page heading is visible immediately.
  await expect(page.getByRole('heading', { name: 'Forecast', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Historical throughput$/i, level: 2 })).toBeVisible();

  // Chart renders once the mocked throughput fetch resolves.
  await expect(page.locator('[aria-label="Daily throughput chart"]')).toBeVisible({
    timeout: 10_000,
  });
});

// ─── Test: Forecast form is present with type selector ───────────────────────

test('forecast form shows type selector and run button', async ({ page }) => {
  await setAdminSession(page);
  await mockThroughputApi(page);

  await page.goto(`/scopes/${scopeId}/forecast`);
  await page.waitForSelector('[aria-label="Daily throughput chart"]', { timeout: 10_000 });

  // Type radio buttons.
  await expect(page.locator('[aria-label="When will we finish?"]')).toBeVisible();
  await expect(page.locator('[aria-label="How many stories by a date?"]')).toBeVisible();

  // Run Forecast button.
  await expect(page.getByRole('button', { name: 'Run Forecast' })).toBeVisible();
});

// ─── Test: When forecast shows completion date results ────────────────────────

test('when forecast returns completion dates table with LOW_SAMPLE_SIZE warning', async ({
  page,
}) => {
  await setAdminSession(page);
  await mockThroughputApi(page);
  await mockForecastApi(page, MOCK_WHEN_RESPONSE);

  await page.goto(`/scopes/${scopeId}/forecast`);
  await page.waitForSelector('[aria-label="Daily throughput chart"]', { timeout: 10_000 });

  // Verify "when" radio is selected (default) and submit.
  await expect(page.locator('[aria-label="When will we finish?"]')).toBeChecked();

  // Intercept the POST body to verify dataVersion is forwarded from throughput response.
  let capturedPostBody: Record<string, unknown> | null = null;
  await page.route(`**/api/v1/scopes/${scopeId}/forecasts**`, async (route) => {
    try {
      capturedPostBody = (await route.request().postDataJSON()) as Record<string, unknown>;
    } catch {
      // ignore
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...MOCK_WHEN_RESPONSE, scopeId }),
    });
  });

  await page.getByRole('button', { name: 'Run Forecast' }).click();

  // Results table appears.
  const forecastResults = page.locator('[aria-label="Forecast results"]');
  await expect(forecastResults).toBeVisible({ timeout: 10_000 });

  // "Completion Date" column header is present (when forecast).
  await expect(
    forecastResults.locator('article').first().getByText('Completion date', { exact: true }),
  ).toBeVisible();

  // At least one result row with a confidence percentage.
  await expect(
    forecastResults.locator('article').first().getByText('50%', { exact: true }),
  ).toBeVisible();

  // LOW_SAMPLE_SIZE warning is displayed.
  await expect(page.getByText(/Only 15 completed stories/)).toBeVisible();

  // Verify the POST body included type, sample window, confidenceLevels, and dataVersion.
  expect(capturedPostBody).not.toBeNull();
  expect(capturedPostBody!['type']).toBe('when');
  expect(capturedPostBody!['sampleMode']).toBe('rolling');
  expect(capturedPostBody!['historicalWindowDays']).toBeDefined();
  expect(capturedPostBody!['confidenceLevels']).toBeDefined();
  expect(capturedPostBody!['dataVersion']).toBe('forecast-e2e-version');
});

// ─── Test: How_many forecast shows story count results ────────────────────────

test('how_many forecast returns story count table', async ({ page }) => {
  await setAdminSession(page);
  await mockThroughputApi(page);
  await mockForecastApi(page, MOCK_HOW_MANY_RESPONSE);

  await page.goto(`/scopes/${scopeId}/forecast`);
  await page.waitForSelector('[aria-label="Daily throughput chart"]', { timeout: 10_000 });

  // Switch to "how_many" type.
  await page.locator('[aria-label="How many stories by a date?"]').click();
  await expect(page.locator('[aria-label="Target completion date"]')).toBeVisible();

  await page.getByRole('button', { name: 'Run Forecast' }).click();

  // Results table shows "Stories Completed" column header.
  const forecastResults = page.locator('[aria-label="Forecast results"]');
  await expect(forecastResults).toBeVisible({ timeout: 10_000 });
  await expect(
    forecastResults.locator('article').first().getByText('Stories completed', { exact: true }),
  ).toBeVisible();

  // One result row should render "12 stories" (from MOCK_HOW_MANY_RESPONSE at 50%).
  await expect(page.getByText('12 stories')).toBeVisible();
});

// ─── Test: Back-to-scope navigation link is present ──────────────────────────

test('forecast page has back-to-scope navigation link', async ({ page }) => {
  await setAdminSession(page);
  await mockThroughputApi(page);

  await page.goto(`/scopes/${scopeId}/forecast`);

  // The back-to-scope affordance now lives in the breadcrumb ("Scope" crumb).
  const breadcrumbScopeLink = page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Scope' });
  await expect(breadcrumbScopeLink).toBeVisible({ timeout: 10_000 });
  await expect(breadcrumbScopeLink).toHaveAttribute('href', `/scopes/${scopeId}`);
});

// ─── Test: Real API — POST /forecasts returns a valid forecast response ───────

test('POST /forecasts returns a valid ForecastResponse for admin user', async ({ page }) => {
  // This test uses the real server-side route (no mock), verifying the full
  // forecast compute path from HTTP request to Monte Carlo output.
  const res = await page.request.post(
    `/api/v1/scopes/${scopeId}/forecasts`,
    {
      headers: {
        Cookie: `agile_session=${adminCookie}`,
        'Content-Type': 'application/json',
        Origin: process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000',
      },
      data: JSON.stringify({
        type: 'when',
        remainingStoryCount: 5,
        historicalWindowDays: 90,
        confidenceLevels: [50, 85],
        iterations: 1000,
      }),
    },
  );

  expect(res.ok()).toBe(true);

  const body = (await res.json()) as ForecastResponse;
  expect(body.scopeId).toBe(scopeId);
  expect(body.type).toBe('when');
  expect(body.sampleMode).toBe('rolling');
  expect(body.historicalWindowDays).toBe(90);
  expect(body.sampleStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(body.sampleEndDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof body.sampleSize).toBe('number');
  expect(typeof body.iterations).toBe('number');
  expect(Array.isArray(body.results)).toBe(true);
  expect(Array.isArray(body.warnings)).toBe(true);

  // sampleSize < 60 → should include a LOW_SAMPLE_SIZE or NO_THROUGHPUT_HISTORY warning.
  // Either way, results should be returned (or be empty if no throughput).
  const warningCodes = body.warnings.map((w: { code: string }) => w.code);
  const hasExpectedWarning =
    warningCodes.includes('LOW_SAMPLE_SIZE') ||
    warningCodes.includes('NO_THROUGHPUT_HISTORY') ||
    warningCodes.includes('NO_DATA');
  expect(hasExpectedWarning).toBe(true);
});
