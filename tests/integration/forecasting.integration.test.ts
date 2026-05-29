/**
 * Integration tests for forecasting: throughput projection, Monte Carlo
 * sampling, and low-confidence warnings.
 *
 * Two sections:
 * 1. Pure unit tests for `runWhenForecast`, `runHowManyForecast`, and
 *    `computeForecastRequestHash` — no DB required.
 * 2. DB integration tests (Testcontainers Postgres) for `queryDailyThroughput`,
 *    `queryCompletedStories`, and the forecast cache round-trip.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { resetConfig } from '@agile-tools/shared';
import {
  getPrismaClient,
  disconnectPrisma,
  queryDailyThroughput,
  queryCompletedStories,
  computeForecastRequestHash,
  lookupForecastCache,
  storeForecastCache,
  formatDateInTimezone,
} from '@agile-tools/db';
import {
  runWhenForecast,
  runHowManyForecast,
  FORECAST_MIN_SAMPLE_SIZE,
} from '../../packages/analytics/src/monte-carlo';
import { startPostgres, stopPostgres } from './support/postgres';

// ─── Section 1: Pure unit tests ───────────────────────────────────────────────

const ROLLING_SAMPLE_WINDOW = {
  sampleMode: 'rolling' as const,
  historicalWindowDays: 90,
  sampleStartDate: '2025-01-01',
  sampleEndDate: '2025-03-31',
};

describe('runWhenForecast — pure unit', () => {
  it('returns the same completion date for all confidence levels when throughput is deterministic', () => {
    // With throughput always exactly 1 story/day, every trial takes exactly 5 days.
    // referenceDate 2025-01-01 + 5 working days = 2025-01-08.
    const result = runWhenForecast({
      historicalDailyThroughput: [1],
      sampleSize: 100,
      remainingStoryCount: 5,
      confidenceLevels: [50, 85, 95],
      iterations: 200,
      referenceDate: new Date('2025-01-01T12:00:00Z'),
      timezone: 'UTC',
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.completionDate).toBe('2025-01-08');
    }
  });

  it('attaches LOW_SAMPLE_SIZE warning when sampleSize is below threshold', () => {
    const result = runWhenForecast({
      historicalDailyThroughput: [1, 2, 3],
      sampleSize: FORECAST_MIN_SAMPLE_SIZE - 1,
      remainingStoryCount: 10,
      confidenceLevels: [50],
      iterations: 100,
    });

    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('LOW_SAMPLE_SIZE');
    expect(result.warnings.find((w) => w.code === 'LOW_SAMPLE_SIZE')!.message).toContain(
      String(FORECAST_MIN_SAMPLE_SIZE - 1),
    );
  });

  it('attaches NO_THROUGHPUT_HISTORY warning and omits completionDate when throughput is all zeros', () => {
    const result = runWhenForecast({
      historicalDailyThroughput: [0, 0, 0],
      sampleSize: 0,
      remainingStoryCount: 5,
      confidenceLevels: [50, 85],
      iterations: 100,
    });

    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('NO_THROUGHPUT_HISTORY');
    expect(result.results).toHaveLength(2);
    for (const r of result.results) {
      expect(r.completionDate).toBeUndefined();
    }
  });

  it('higher confidence level yields the same or later completion date', () => {
    // Variable throughput: 3, 1, 2, 0, 1 — stochastic but predictable ordering.
    const result = runWhenForecast({
      historicalDailyThroughput: [3, 1, 2, 0, 1],
      sampleSize: 100,
      remainingStoryCount: 20,
      confidenceLevels: [50, 70, 85, 95],
      iterations: 500,
      referenceDate: new Date('2025-01-01T12:00:00Z'),
      timezone: 'UTC',
    });

    expect(result.warnings).toHaveLength(0);
    const dates = result.results.map((r) => r.completionDate!);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]! >= dates[i - 1]!).toBe(true);
    }
  });
});

describe('runHowManyForecast — pure unit', () => {
  it('returns the same story count for all confidence levels when throughput is deterministic', () => {
    // With throughput always exactly 2 stories/day × 5 days = always 10 stories per trial.
    const result = runHowManyForecast({
      historicalDailyThroughput: [2],
      sampleSize: 100,
      targetDays: 5,
      confidenceLevels: [50, 70, 85, 95],
      iterations: 200,
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.results).toHaveLength(4);
    for (const r of result.results) {
      expect(r.completedStoryCount).toBe(10);
    }
  });

  it('attaches LOW_SAMPLE_SIZE warning when sampleSize is below threshold', () => {
    const result = runHowManyForecast({
      historicalDailyThroughput: [1, 2],
      sampleSize: FORECAST_MIN_SAMPLE_SIZE - 1,
      targetDays: 14,
      confidenceLevels: [85],
      iterations: 100,
    });

    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('LOW_SAMPLE_SIZE');
  });

  it('attaches NO_THROUGHPUT_HISTORY warning and omits completedStoryCount when throughput is all zeros', () => {
    const result = runHowManyForecast({
      historicalDailyThroughput: [0, 0],
      sampleSize: 0,
      targetDays: 14,
      confidenceLevels: [50, 85],
      iterations: 100,
    });

    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('NO_THROUGHPUT_HISTORY');
    expect(result.results).toHaveLength(2);
    for (const r of result.results) {
      expect(r.completedStoryCount).toBeUndefined();
    }
  });

  it('higher confidence level yields the same or fewer stories (more conservative)', () => {
    const result = runHowManyForecast({
      historicalDailyThroughput: [3, 1, 2, 0, 1],
      sampleSize: 100,
      targetDays: 20,
      confidenceLevels: [50, 70, 85, 95],
      iterations: 500,
    });

    expect(result.warnings).toHaveLength(0);
    const counts = result.results.map((r) => r.completedStoryCount!);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]! <= counts[i - 1]!).toBe(true);
    }
  });
});

describe('computeForecastRequestHash — pure unit', () => {
  it('produces the same hash for identical inputs', () => {
    const input = {
      type: 'when' as const,
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 10000,
      confidenceLevels: [50, 85],
      remainingStoryCount: 10,
    };
    expect(computeForecastRequestHash(input)).toBe(computeForecastRequestHash(input));
  });

  it('produces the same hash regardless of confidence level order', () => {
    const base = {
      type: 'how_many' as const,
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 10000,
      targetDate: '2025-06-01',
    };
    const hash1 = computeForecastRequestHash({ ...base, confidenceLevels: [85, 50, 70] });
    const hash2 = computeForecastRequestHash({ ...base, confidenceLevels: [50, 70, 85] });
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different remainingStoryCount values', () => {
    const base = {
      type: 'when' as const,
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 10000,
      confidenceLevels: [85],
    };
    const h5 = computeForecastRequestHash({ ...base, remainingStoryCount: 5 });
    const h10 = computeForecastRequestHash({ ...base, remainingStoryCount: 10 });
    expect(h5).not.toBe(h10);
  });

  it('produces different hashes for when vs how_many', () => {
    const h1 = computeForecastRequestHash({
      type: 'when',
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 10000,
      confidenceLevels: [85],
      remainingStoryCount: 10,
    });
    const h2 = computeForecastRequestHash({
      type: 'how_many',
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 10000,
      confidenceLevels: [85],
      targetDate: '2025-06-01',
    });
    expect(h1).not.toBe(h2);
  });
});

// ─── Section 2: DB integration tests ─────────────────────────────────────────

let dbStarted = false;

async function ensureDbStarted() {
  if (dbStarted) return;
  const pg = await startPostgres();
  process.env['DATABASE_URL'] = pg.connectionUrl;
  process.env['ENCRYPTION_KEY'] = 'test-encryption-key-32-chars-ok!';
  dbStarted = true;
}

afterAll(async () => {
  await disconnectPrisma();
  await stopPostgres();
});

// ─── queryDailyThroughput tests ───────────────────────────────────────────────

describe('queryDailyThroughput — DB integration', () => {
  let scopeId: string;
  let syncRunId: string;
  let wednesdayDay: string;
  let fridayDay: string;
  let saturdayNoon: Date;
  let sundayNoon: Date;

  beforeAll(async () => {
    await ensureDbStarted();
    resetConfig();
    await disconnectPrisma();

    const db = getPrismaClient();

    const workspace = await db.workspace.create({
      data: { name: 'Throughput Test Workspace', defaultTimezone: 'UTC' },
    });

    const conn = await db.jiraConnection.create({
      data: {
        workspaceId: workspace.id,
        baseUrl: 'https://jira.example.internal',
        authType: 'pat',
        encryptedSecretRef: 'dummy',
      },
    });

    const scope = await db.flowScope.create({
      data: {
        workspaceId: workspace.id,
        connectionId: conn.id,
        boardId: '20',
        boardName: 'Throughput Test Board',
        timezone: 'UTC',
        includedIssueTypeIds: ['story'],
        startStatusIds: ['10'],
        doneStatusIds: ['30'],
        syncIntervalMinutes: 10,
      },
    });
    scopeId = scope.id;

    const syncRun = await db.syncRun.create({
      data: {
        scopeId,
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date('2025-01-01T00:00:00Z'),
        finishedAt: new Date('2025-01-10T00:00:00Z'),
      },
    });
    syncRunId = syncRun.id;

    const wednesdayNoon = new Date('2025-01-08T12:00:00Z');
    const fridayNoon = new Date('2025-01-10T12:00:00Z');
    saturdayNoon = new Date('2025-01-11T12:00:00Z');
    sundayNoon = new Date('2025-01-12T12:00:00Z');

    wednesdayDay = formatDateInTimezone(wednesdayNoon, 'UTC');
    fridayDay = formatDateInTimezone(fridayNoon, 'UTC');

    // 1 item completed on Wednesday; 2 on Friday; weekend completions should
    // also roll back into Friday's working-day bucket.
    await db.workItem.createMany({
      data: [
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'TH-1',
          issueKey: 'TH-1',
          summary: 'Done item 1',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'TH',
          currentStatusId: '30',
          currentColumn: 'Done',
          directUrl: 'https://jira.example.internal/browse/TH-1',
          createdAt: wednesdayNoon,
          startedAt: wednesdayNoon,
          completedAt: wednesdayNoon,
        },
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'TH-2',
          issueKey: 'TH-2',
          summary: 'Done item 2',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'TH',
          currentStatusId: '30',
          currentColumn: 'Done',
          directUrl: 'https://jira.example.internal/browse/TH-2',
          createdAt: fridayNoon,
          startedAt: fridayNoon,
          completedAt: fridayNoon,
        },
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'TH-3',
          issueKey: 'TH-3',
          summary: 'Done item 3',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'TH',
          currentStatusId: '30',
          currentColumn: 'Done',
          directUrl: 'https://jira.example.internal/browse/TH-3',
          createdAt: fridayNoon,
          startedAt: fridayNoon,
          completedAt: fridayNoon,
        },
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'TH-4',
          issueKey: 'TH-4',
          summary: 'Weekend item saturday',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'TH',
          currentStatusId: '30',
          currentColumn: 'Done',
          directUrl: 'https://jira.example.internal/browse/TH-4',
          createdAt: saturdayNoon,
          startedAt: saturdayNoon,
          completedAt: saturdayNoon,
        },
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'TH-5',
          issueKey: 'TH-5',
          summary: 'Weekend item sunday',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'TH',
          currentStatusId: '30',
          currentColumn: 'Done',
          directUrl: 'https://jira.example.internal/browse/TH-5',
          createdAt: sundayNoon,
          startedAt: sundayNoon,
          completedAt: sundayNoon,
        },
      ],
    });
  });

  it('returns one row per working day with YYYY-MM-DD format', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-13T12:00:00Z'));
    try {
      const db = getPrismaClient();
      const days = await queryDailyThroughput(db, scopeId, 'UTC', { windowDays: 7 });

      expect(days).toHaveLength(6);
      expect(days.map((d) => d.day)).not.toEqual(
        expect.arrayContaining(['2025-01-11', '2025-01-12']),
      );
      for (const d of days) {
        expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(d.completedStoryCount).toBeGreaterThanOrEqual(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-buckets weekend completions onto the previous working day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-13T12:00:00Z'));
    try {
      const db = getPrismaClient();
      const days = await queryDailyThroughput(db, scopeId, 'UTC', { windowDays: 7 });

      const byDay = new Map(days.map((d) => [d.day, d.completedStoryCount]));

      expect(byDay.get(wednesdayDay)).toBe(1);
      expect(byDay.get(fridayDay)).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps zero-throughput weekdays while omitting weekend buckets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-13T12:00:00Z'));
    try {
      const db = getPrismaClient();
      const days = await queryDailyThroughput(db, scopeId, 'UTC', { windowDays: 7 });

      const nonZeroDays = days.filter((d) => d.completedStoryCount > 0).map((d) => d.day);
      expect(nonZeroDays).toEqual(expect.arrayContaining([wednesdayDay, fridayDay]));
      expect(nonZeroDays).toHaveLength(2);
      expect(days.find((d) => d.day === '2025-01-11')).toBeUndefined();
      expect(days.find((d) => d.day === '2025-01-12')).toBeUndefined();
      expect(days.find((d) => d.day === '2025-01-09')?.completedStoryCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the current working day incomplete and past working days complete', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-13T12:00:00Z'));
    try {
      const db = getPrismaClient();
      const days = await queryDailyThroughput(db, scopeId, 'UTC', { windowDays: 7 });

      const today = formatDateInTimezone(new Date(), 'UTC');

      const todayEntry = days.find((d) => d.day === today);
      expect(todayEntry).toBeDefined();
      expect(todayEntry!.complete).toBe(false);

      const pastDays = days.filter((d) => d.day < today);
      expect(pastDays.length).toBeGreaterThan(0);
      expect(pastDays.every((d) => d.complete)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats the rebucket target as the current working day on weekends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-12T12:00:00Z'));
    try {
      const db = getPrismaClient();
      const days = await queryDailyThroughput(db, scopeId, 'UTC', { windowDays: 7 });

      expect(days.at(-1)?.day).toBe(fridayDay);
      expect(days.find((d) => d.day === fridayDay)?.complete).toBe(false);
      expect(days.filter((d) => d.day < fridayDay).every((d) => d.complete)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes the rebucket target when the calendar window starts on a weekend', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-13T12:00:00Z'));
    try {
      const db = getPrismaClient();
      const days = await queryDailyThroughput(db, scopeId, 'UTC', { windowDays: 2 });
      const byDay = new Map(days.map((d) => [d.day, d.completedStoryCount]));

      expect(days.map((d) => d.day)).toEqual(['2025-01-10', '2025-01-13']);
      expect(byDay.get('2025-01-10')).toBe(2);
      expect(byDay.get('2025-01-13')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── queryCompletedStories tests ──────────────────────────────────────────────

describe('queryCompletedStories — DB integration', () => {
  let scopeId: string;
  let syncRunId: string;

  beforeAll(async () => {
    await ensureDbStarted();
    resetConfig();
    await disconnectPrisma();

    const db = getPrismaClient();

    const workspace = await db.workspace.create({
      data: { name: 'Completed Stories Test Workspace', defaultTimezone: 'UTC' },
    });

    const conn = await db.jiraConnection.create({
      data: {
        workspaceId: workspace.id,
        baseUrl: 'https://jira.example.internal',
        authType: 'pat',
        encryptedSecretRef: 'dummy',
      },
    });

    const scope = await db.flowScope.create({
      data: {
        workspaceId: workspace.id,
        connectionId: conn.id,
        boardId: '21',
        boardName: 'Completed Stories Board',
        timezone: 'UTC',
        includedIssueTypeIds: ['story'],
        startStatusIds: ['10'],
        doneStatusIds: ['30'],
        syncIntervalMinutes: 10,
      },
    });
    scopeId = scope.id;

    const syncRun = await db.syncRun.create({
      data: {
        scopeId,
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date('2025-01-01T00:00:00Z'),
        finishedAt: new Date('2025-01-10T00:00:00Z'),
      },
    });
    syncRunId = syncRun.id;

    const startedJan1 = new Date('2025-01-01T00:00:00Z');
    const completedJan8 = new Date('2025-01-08T00:00:00Z');
    const startedJan9 = new Date('2025-01-09T00:00:00Z');
    const completedJan14 = new Date('2025-01-14T00:00:00Z');

    await db.workItem.createMany({
      data: [
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'CS-1',
          issueKey: 'CS-1',
          summary: 'Completed item A',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'CS',
          currentStatusId: '30',
          currentColumn: 'Done',
          directUrl: 'https://jira.example.internal/browse/CS-1',
          createdAt: startedJan1,
          startedAt: startedJan1,
          completedAt: completedJan8,
        },
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'CS-2',
          issueKey: 'CS-2',
          summary: 'Completed item B',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'CS',
          currentStatusId: '30',
          currentColumn: 'Done',
          directUrl: 'https://jira.example.internal/browse/CS-2',
          createdAt: startedJan9,
          startedAt: startedJan9,
          completedAt: completedJan14,
        },
        // This item should be excluded from results.
        {
          scopeId,
          lastSyncRunId: syncRunId,
          jiraIssueId: 'CS-3',
          issueKey: 'CS-3',
          summary: 'Excluded item',
          issueTypeId: 'story',
          issueTypeName: 'Story',
          projectId: 'CS',
          currentStatusId: '30',
          currentColumn: 'Done',
          directUrl: 'https://jira.example.internal/browse/CS-3',
          createdAt: startedJan9,
          startedAt: startedJan9,
          completedAt: completedJan14,
          excludedReason: 'manual',
        },
      ],
    });
  });

  it('returns only non-excluded completed stories within the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-17T12:00:00Z'));
    try {
      const db = getPrismaClient();
      const stories = await queryCompletedStories(db, scopeId, { windowDays: 90, timezone: 'UTC' });

      expect(stories).toHaveLength(2);
      const keys = stories.map((s) => s.issueKey);
      expect(keys).toContain('CS-1');
      expect(keys).toContain('CS-2');
      expect(keys).not.toContain('CS-3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('computes cycle time correctly for each story', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-17T12:00:00Z'));
    try {
      const db = getPrismaClient();
      const stories = await queryCompletedStories(db, scopeId, { windowDays: 90, timezone: 'UTC' });

      const cs1 = stories.find((s) => s.issueKey === 'CS-1')!;
      const cs2 = stories.find((s) => s.issueKey === 'CS-2')!;

      expect(cs1.cycleTimeDays).toBeCloseTo(5, 5);
      expect(cs2.cycleTimeDays).toBeCloseTo(3, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes stories completed outside the historical window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-17T12:00:00Z'));
    try {
      const db = getPrismaClient();
      const stories = await queryCompletedStories(db, scopeId, { windowDays: 5, timezone: 'UTC' });

      expect(stories).toHaveLength(1);
      expect(stories[0]!.issueKey).toBe('CS-2');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Forecast cache round-trip tests ─────────────────────────────────────────

describe('forecast cache round-trip — DB integration', () => {
  let scopeId: string;

  beforeAll(async () => {
    await ensureDbStarted();
    resetConfig();
    await disconnectPrisma();

    const db = getPrismaClient();

    const workspace = await db.workspace.create({
      data: { name: 'Cache Test Workspace', defaultTimezone: 'UTC' },
    });

    const conn = await db.jiraConnection.create({
      data: {
        workspaceId: workspace.id,
        baseUrl: 'https://jira.example.internal',
        authType: 'pat',
        encryptedSecretRef: 'dummy',
      },
    });

    const scope = await db.flowScope.create({
      data: {
        workspaceId: workspace.id,
        connectionId: conn.id,
        boardId: '22',
        boardName: 'Cache Test Board',
        timezone: 'UTC',
        includedIssueTypeIds: ['story'],
        startStatusIds: ['10'],
        doneStatusIds: ['30'],
        syncIntervalMinutes: 10,
      },
    });
    scopeId = scope.id;
  });

  it('returns null for a cache miss (unknown requestHash)', async () => {
    const db = getPrismaClient();
    const hash = computeForecastRequestHash({
      type: 'when',
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 1000,
      confidenceLevels: [50],
      remainingStoryCount: 99,
    });
    const result = await lookupForecastCache(db, scopeId, hash, 'no-such-version');
    expect(result).toBeNull();
  });

  it('stores and retrieves a cached forecast result with correct payload and sampleSize', async () => {
    const db = getPrismaClient();
    const hash = computeForecastRequestHash({
      type: 'when',
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 1000,
      confidenceLevels: [50, 85],
      remainingStoryCount: 10,
    });
    const dataVersion = 'cache-test-v1';
    const payload = {
      results: [
        { confidenceLevel: 50, completionDate: '2025-06-01' },
        { confidenceLevel: 85, completionDate: '2025-07-15' },
      ],
      warnings: [],
    };

    await storeForecastCache(db, {
      scopeId,
      requestHash: hash,
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 1000,
      confidenceLevels: [50, 85],
      sampleSize: 75,
      dataVersion,
      payload,
    });

    const cached = await lookupForecastCache(db, scopeId, hash, dataVersion);
    expect(cached).not.toBeNull();
    expect(cached!.sampleSize).toBe(75);
    expect(cached!.payload.results).toHaveLength(2);
    expect(cached!.payload.results[0]!.completionDate).toBe('2025-06-01');
    expect(cached!.payload.results[1]!.completionDate).toBe('2025-07-15');
    expect(cached!.payload.warnings).toHaveLength(0);
  });

  it('upsert overwrites an existing cache entry with the same key', async () => {
    const db = getPrismaClient();
    const hash = computeForecastRequestHash({
      type: 'when',
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 1000,
      confidenceLevels: [50],
      remainingStoryCount: 5,
    });
    const dataVersion = 'cache-test-v2';

    const firstPayload = {
      results: [{ confidenceLevel: 50, completionDate: '2025-05-01' }],
      warnings: [],
    };
    const secondPayload = {
      results: [{ confidenceLevel: 50, completionDate: '2025-05-15' }],
      warnings: [{ code: 'LOW_SAMPLE_SIZE', message: 'Only 30 stories.' }],
    };

    await storeForecastCache(db, {
      scopeId,
      requestHash: hash,
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 1000,
      confidenceLevels: [50],
      sampleSize: 30,
      dataVersion,
      payload: firstPayload,
    });
    await storeForecastCache(db, {
      scopeId,
      requestHash: hash,
      sampleWindow: ROLLING_SAMPLE_WINDOW,
      iterations: 1000,
      confidenceLevels: [50],
      sampleSize: 30,
      dataVersion,
      payload: secondPayload,
    });

    const cached = await lookupForecastCache(db, scopeId, hash, dataVersion);
    expect(cached).not.toBeNull();
    expect(cached!.payload.results[0]!.completionDate).toBe('2025-05-15');
    expect(cached!.payload.warnings).toHaveLength(1);
  });
});
