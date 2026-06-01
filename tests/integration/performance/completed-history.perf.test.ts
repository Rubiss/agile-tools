/**
 * Completed-history performance benchmarks.
 *
 * This suite targets the production concern where boards with 1000+ completed
 * stories showed PostgreSQL read times measured in seconds. It can run either
 * against a disposable Testcontainers PostgreSQL instance or an already-running
 * local Docker database:
 *
 *   $env:PERF_USE_EXISTING_DATABASE="true"
 *   $env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/agile_tools"
 *   pnpm exec vitest run --config tests/integration/performance/vitest.config.ts tests/integration/performance/completed-history.perf.test.ts
 *
 * Optional:
 *   $env:PERF_COMPLETED_COUNTS="1000,2500,5000"
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { resetConfig } from '@agile-tools/shared';
import {
  disconnectPrisma,
  getPrismaClient,
  queryCurrentWorkItems,
  queryDailyThroughput,
  queryCompletedStories,
  lookupForecastCache,
  storeForecastCache,
  computeForecastRequestHash,
} from '@agile-tools/db';
import {
  runWhenForecast,
  DEFAULT_MONTE_CARLO_ITERATIONS,
} from '../../../packages/analytics/src/monte-carlo';
import { startPostgres, stopPostgres } from '../support/postgres';

const ACTIVE_ITEM_COUNT = Number(process.env['PERF_ACTIVE_ITEM_COUNT'] ?? '300');
const SAMPLES = Number(process.env['PERF_SAMPLES'] ?? '12');
const COMPLETED_COUNTS = parseCompletedCounts(process.env['PERF_COMPLETED_COUNTS'] ?? '1000,2500,5000');
const USE_EXISTING_DATABASE = process.env['PERF_USE_EXISTING_DATABASE'] === 'true';

const DB_QUERY_P95_MS = Number(process.env['PERF_DB_QUERY_P95_MS'] ?? '500');
const FORECAST_COMPUTE_BUDGET_MS = Number(process.env['PERF_FORECAST_BUDGET_MS'] ?? '3000');

interface PerfScenario {
  label: string;
  completedCount: number;
  scopeId: string;
  syncRunId: string;
  timezone: string;
}

interface TimingStats {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface ExplainSummary {
  planningMs?: number;
  executionMs?: number;
  topNode?: string;
  relationNodes: string[];
}

interface WorkItemStartRow {
  id: string;
  startedAt: Date | null;
}

interface CompletedWorkItemDateRow extends WorkItemStartRow {
  completedAt: Date | null;
}

let workspaceId: string | undefined;
let scenarios: PerfScenario[] = [];

beforeAll(async () => {
  if (USE_EXISTING_DATABASE) {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required when PERF_USE_EXISTING_DATABASE=true');
    }
  } else {
    const pg = await startPostgres();
    process.env['DATABASE_URL'] = pg.connectionUrl;
  }

  process.env['ENCRYPTION_KEY'] = 'perf-test-encryption-key-32chars!';
  resetConfig();
  await disconnectPrisma();

  const db = getPrismaClient();
  scenarios = await seedScenarios(db, COMPLETED_COUNTS);
}, 300_000);

afterAll(async () => {
  const db = getPrismaClient();
  if (workspaceId) {
    await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  }
  await disconnectPrisma();
  if (!USE_EXISTING_DATABASE) {
    await stopPostgres();
  }
}, 120_000);

describe('completed-history DB read performance', () => {
  it(`queryDailyThroughput p95 < ${DB_QUERY_P95_MS} ms across completed-history scenarios`, async () => {
    for (const scenario of scenarios) {
      const db = getPrismaClient();
      const times = await measureMs(
        () =>
          queryDailyThroughput(db, scenario.scopeId, scenario.timezone, {
            sampleStartDate: '2024-01-01',
            sampleEndDate: '2025-12-31',
            anchorDate: new Date('2026-01-05T12:00:00.000Z'),
            dataVersion: scenario.syncRunId,
          }).then(() => undefined),
        SAMPLES,
      );

      const stats = timingStats(times);
      logStats(scenario, 'queryDailyThroughput 730d', stats);
      expect(stats.p95).toBeLessThan(DB_QUERY_P95_MS);
    }
  });

  it(`queryCompletedStories p95 < ${DB_QUERY_P95_MS} ms across completed-history scenarios`, async () => {
    for (const scenario of scenarios) {
      const db = getPrismaClient();
      const times = await measureMs(
        () =>
          queryCompletedStories(db, scenario.scopeId, {
            windowDays: 730,
            dataVersion: scenario.syncRunId,
            timezone: scenario.timezone,
          }).then(() => undefined),
        SAMPLES,
      );

      const stats = timingStats(times);
      logStats(scenario, 'queryCompletedStories 730d', stats);
      expect(stats.p95).toBeLessThan(DB_QUERY_P95_MS);
    }
  });

  it(`queryCurrentWorkItems p95 < ${DB_QUERY_P95_MS} ms across completed-history scenarios`, async () => {
    for (const scenario of scenarios) {
      const db = getPrismaClient();
      const times = await measureMs(
        () =>
          queryCurrentWorkItems(db, scenario.scopeId, {
            dataVersion: scenario.syncRunId,
            timezone: scenario.timezone,
            now: new Date('2026-01-05T12:00:00.000Z'),
          }).then(() => undefined),
        SAMPLES,
      );

      const stats = timingStats(times);
      logStats(scenario, 'queryCurrentWorkItems', stats);
      expect(stats.p95).toBeLessThan(DB_QUERY_P95_MS);
    }
  });

  it('forecast cache miss/hit stays inside local budget across completed-history scenarios', async () => {
    for (const scenario of scenarios) {
      const db = getPrismaClient();
      const sampleWindow = {
        sampleMode: 'rolling' as const,
        historicalWindowDays: 730,
        sampleStartDate: '2024-01-01',
        sampleEndDate: '2025-12-31',
      };
      const requestHash = computeForecastRequestHash({
        type: 'when',
        sampleWindow,
        iterations: DEFAULT_MONTE_CARLO_ITERATIONS,
        confidenceLevels: [50, 70, 85, 95],
        remainingStoryCount: 50,
      });

      await db.forecastResultCache.deleteMany({
        where: { scopeId: scenario.scopeId, requestHash, dataVersion: scenario.syncRunId },
      });

      const startedAt = performance.now();
      const days = await queryDailyThroughput(db, scenario.scopeId, scenario.timezone, {
        sampleStartDate: sampleWindow.sampleStartDate,
        sampleEndDate: sampleWindow.sampleEndDate,
        anchorDate: new Date('2026-01-05T12:00:00.000Z'),
        dataVersion: scenario.syncRunId,
      });
      const completeDays = days.filter((day) => day.complete);
      const historicalDailyThroughput = completeDays.map((day) => day.completedStoryCount);
      const sampleSize = completeDays.reduce((sum, day) => sum + day.completedStoryCount, 0);
      const monteCarlo = runWhenForecast({
        historicalDailyThroughput,
        sampleSize,
        remainingStoryCount: 50,
        confidenceLevels: [50, 70, 85, 95],
        iterations: DEFAULT_MONTE_CARLO_ITERATIONS,
        timezone: scenario.timezone,
      });
      await storeForecastCache(db, {
        scopeId: scenario.scopeId,
        requestHash,
        sampleWindow,
        iterations: DEFAULT_MONTE_CARLO_ITERATIONS,
        confidenceLevels: [50, 70, 85, 95],
        sampleSize,
        dataVersion: scenario.syncRunId,
        payload: {
          results: monteCarlo.results,
          warnings: monteCarlo.warnings,
        },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      const missElapsed = performance.now() - startedAt;

      const hitTimes = await measureMs(
        () => lookupForecastCache(db, scenario.scopeId, requestHash, scenario.syncRunId).then(() => undefined),
        SAMPLES,
      );
      const hitStats = timingStats(hitTimes);

      console.info(
        `[perf:${scenario.label}] forecast miss=${missElapsed.toFixed(1)}ms sampleSize=${sampleSize} cacheHit p95=${hitStats.p95.toFixed(1)}ms`,
      );
      expect(missElapsed).toBeLessThan(FORECAST_COMPUTE_BUDGET_MS);
      expect(hitStats.p95).toBeLessThan(DB_QUERY_P95_MS);
    }
  });
});

describe('completed-history PostgreSQL plans', () => {
  it('captures completed-work lookup plans across completed-history scenarios', async () => {
    for (const scenario of scenarios) {
      const db = getPrismaClient();
      const summary = await explainCompletedLookup(db, {
        scopeId: scenario.scopeId,
        syncRunId: scenario.syncRunId,
        start: new Date('2024-01-01T00:00:00.000Z'),
        end: new Date('2025-12-31T23:59:59.999Z'),
      });

      console.info(
        `[perf:${scenario.label}] EXPLAIN completed lookup planning=${formatOptionalMs(summary.planningMs)} execution=${formatOptionalMs(summary.executionMs)} top=${summary.topNode ?? 'unknown'} nodes=${summary.relationNodes.join(' > ')}`,
      );
      expect(summary.executionMs ?? 0).toBeLessThan(DB_QUERY_P95_MS);
      expect(summary.relationNodes.length).toBeGreaterThan(0);
    }
  });
});

async function seedScenarios(db: PrismaClient, completedCounts: number[]): Promise<PerfScenario[]> {
  const workspace = await db.workspace.create({
    data: {
      name: `Perf Completed History ${new Date().toISOString()}`,
      defaultTimezone: 'UTC',
    },
  });
  workspaceId = workspace.id;

  const connection = await db.jiraConnection.create({
    data: {
      workspaceId: workspace.id,
      baseUrl: 'https://jira.perf.test',
      authType: 'pat',
      encryptedSecretRef: 'dummy-encrypted',
    },
  });

  const seeded: PerfScenario[] = [];
  for (const completedCount of completedCounts) {
    const scope = await db.flowScope.create({
      data: {
        workspaceId: workspace.id,
        connectionId: connection.id,
        boardId: `perf-${completedCount}`,
        boardName: `Perf ${completedCount} Completed`,
        timezone: 'UTC',
        includedIssueTypeIds: ['story'],
        includedIssueTypeNames: ['Story'],
        startStatusIds: ['10'],
        doneStatusIds: ['30'],
        syncIntervalMinutes: 10,
      },
    });

    const syncRun = await db.syncRun.create({
      data: {
        scopeId: scope.id,
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date('2026-01-05T08:00:00.000Z'),
        finishedAt: new Date('2026-01-05T08:15:00.000Z'),
      },
    });

    await db.syncRun.update({
      where: { id: syncRun.id },
      data: { dataVersion: syncRun.id },
    });

    await db.agingThresholdModel.create({
      data: {
        scopeId: scope.id,
        historicalWindowDays: 730,
        sampleSize: completedCount,
        metricBasis: 'cycle_time',
        p50: 6,
        p70: 10,
        p85: 15,
        columnThresholds: [
          {
            columnName: 'In Progress',
            sampleSize: completedCount,
            p50: 4,
            p70: 7,
            p85: 10,
          },
        ],
        calculatedAt: new Date('2026-01-05T08:15:00.000Z'),
        dataVersion: syncRun.id,
      },
    });

    const seededScopeId = String(scope.id);
    const seededSyncRunId = String(syncRun.id);
    await seedActiveWorkItems(db, seededScopeId, seededSyncRunId, ACTIVE_ITEM_COUNT);
    await seedCompletedWorkItems(db, seededScopeId, seededSyncRunId, completedCount);

    seeded.push({
      label: `${completedCount}-completed`,
      completedCount,
      scopeId: seededScopeId,
      syncRunId: seededSyncRunId,
      timezone: String(scope.timezone),
    });
  }

  await db.$executeRawUnsafe('ANALYZE "WorkItem"');
  await db.$executeRawUnsafe('ANALYZE "HoldPeriod"');
  await db.$executeRawUnsafe('ANALYZE "WorkItemLifecycleEvent"');
  await db.$executeRawUnsafe('ANALYZE "ForecastResultCache"');

  return seeded;
}

async function seedActiveWorkItems(
  db: PrismaClient,
  scopeId: string,
  syncRunId: string,
  count: number,
): Promise<void> {
  const anchor = new Date('2026-01-05T12:00:00.000Z').getTime();
  const activeItems: Prisma.WorkItemCreateManyInput[] = Array.from({ length: count }, (_, i) => {
    const startedAt = new Date(anchor - (i + 1) * 86_400_000);
    return {
      scopeId,
      jiraIssueId: `ACTIVE-${scopeId}-${i + 1}`,
      issueKey: `PERF-A-${i + 1}`,
      summary: `Active story ${i + 1}`,
      issueTypeId: 'story',
      issueTypeName: 'Story',
      projectId: 'PERF',
      currentStatusId: '20',
      currentStatusName: 'In Progress',
      currentColumn: 'In Progress',
      assigneeName: i % 3 === 0 ? `Person ${i % 10}` : null,
      createdAt: new Date(startedAt.getTime() - 2 * 86_400_000),
      startedAt,
      completedAt: null,
      directUrl: `https://jira.perf.test/browse/PERF-A-${i + 1}`,
      lastSyncRunId: syncRunId,
      updatedAt: new Date(),
    };
  });

  await createWorkItemsInChunks(db, activeItems);

  const activeIds = (await db.workItem.findMany({
    where: { scopeId, completedAt: null },
    select: { id: true, startedAt: true },
  })) as WorkItemStartRow[];

  const holdPeriods: Prisma.HoldPeriodCreateManyInput[] = activeIds
    .filter((_, index) => index % 5 === 0)
    .map((item, index) => {
      const startedAt = item.startedAt ?? new Date();
      return {
        workItemId: item.id,
        startedAt: new Date(startedAt.getTime() + 86_400_000),
        endedAt:
          index % 2 === 0 ? null : new Date(startedAt.getTime() + 2 * 86_400_000),
        source: 'status',
        sourceValue: '25',
      };
    });
  await createHoldPeriodsInChunks(db, holdPeriods);

  const events: Prisma.WorkItemLifecycleEventCreateManyInput[] = activeIds.flatMap((item, index) => [
    {
      workItemId: item.id,
      rawChangelogId: `active-${item.id}-start`,
      eventType: 'status_change' as const,
      fromStatusId: '10',
      toStatusId: '20',
      changedAt: item.startedAt ?? new Date(anchor - index * 86_400_000),
    },
  ]);
  await createLifecycleEventsInChunks(db, events);
}

async function seedCompletedWorkItems(
  db: PrismaClient,
  scopeId: string,
  syncRunId: string,
  count: number,
): Promise<void> {
  const start = Date.parse('2024-01-01T12:00:00.000Z');
  const end = Date.parse('2025-12-31T12:00:00.000Z');
  const span = end - start;

  const completedItems: Prisma.WorkItemCreateManyInput[] = Array.from({ length: count }, (_, i) => {
    const completedAt = new Date(start + Math.floor((span * i) / Math.max(1, count - 1)));
    const cycleDays = 2 + (i % 21);
    const startedAt = new Date(completedAt.getTime() - cycleDays * 86_400_000);
    return {
      scopeId,
      jiraIssueId: `COMPLETED-${scopeId}-${i + 1}`,
      issueKey: `PERF-C-${i + 1}`,
      summary: `Completed story ${i + 1}`,
      issueTypeId: 'story',
      issueTypeName: 'Story',
      projectId: 'PERF',
      currentStatusId: '30',
      currentStatusName: 'Done',
      currentColumn: 'Done',
      assigneeName: i % 4 === 0 ? `Person ${i % 12}` : null,
      createdAt: new Date(startedAt.getTime() - 2 * 86_400_000),
      startedAt,
      completedAt,
      reopenedCount: i % 20 === 0 ? 1 : 0,
      directUrl: `https://jira.perf.test/browse/PERF-C-${i + 1}`,
      lastSyncRunId: syncRunId,
      updatedAt: new Date(),
    };
  });

  await createWorkItemsInChunks(db, completedItems);

  const completedIds = (await db.workItem.findMany({
    where: { scopeId, completedAt: { not: null } },
    select: { id: true, startedAt: true, completedAt: true },
  })) as CompletedWorkItemDateRow[];

  const holdPeriods: Prisma.HoldPeriodCreateManyInput[] = completedIds
    .filter((_, index) => index % 10 === 0)
    .map((item) => {
      const startedAt = item.startedAt ?? new Date();
      return {
        workItemId: item.id,
        startedAt: new Date(startedAt.getTime() + 86_400_000),
        endedAt: new Date(startedAt.getTime() + 2 * 86_400_000),
        source: 'status',
        sourceValue: '25',
      };
    });
  await createHoldPeriodsInChunks(db, holdPeriods);

  const eventSample = completedIds.filter((_, index) => index % 2 === 0);
  const events: Prisma.WorkItemLifecycleEventCreateManyInput[] = eventSample.flatMap((item) => {
    const startedAt = item.startedAt ?? new Date();
    const completedAt = item.completedAt ?? new Date(startedAt.getTime() + 5 * 86_400_000);
    return [
      {
        workItemId: item.id,
        rawChangelogId: `${item.id}-start`,
        eventType: 'status_change' as const,
        fromStatusId: '10',
        toStatusId: '20',
        changedAt: startedAt,
      },
      {
        workItemId: item.id,
        rawChangelogId: `${item.id}-done`,
        eventType: 'completed' as const,
        fromStatusId: '20',
        toStatusId: '30',
        changedAt: completedAt,
      },
    ];
  });
  await createLifecycleEventsInChunks(db, events);
}

async function createWorkItemsInChunks(
  db: PrismaClient,
  rows: Prisma.WorkItemCreateManyInput[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    await db.workItem.createMany({ data: rows.slice(i, i + 500) });
  }
}

async function createHoldPeriodsInChunks(
  db: PrismaClient,
  rows: Prisma.HoldPeriodCreateManyInput[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    await db.holdPeriod.createMany({ data: rows.slice(i, i + 500) });
  }
}

async function createLifecycleEventsInChunks(
  db: PrismaClient,
  rows: Prisma.WorkItemLifecycleEventCreateManyInput[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    await db.workItemLifecycleEvent.createMany({ data: rows.slice(i, i + 500) });
  }
}

async function measureMs(fn: () => Promise<void>, samples: number): Promise<number[]> {
  const times: number[] = [];
  await fn();
  for (let i = 0; i < samples; i++) {
    const startedAt = performance.now();
    await fn();
    times.push(performance.now() - startedAt);
  }
  return times;
}

function timingStats(times: number[]): TimingStats {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)] ?? 0;
}

function logStats(scenario: PerfScenario, name: string, stats: TimingStats): void {
  console.info(
    `[perf:${scenario.label}] ${name} min=${stats.min.toFixed(1)}ms p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms p99=${stats.p99.toFixed(1)}ms max=${stats.max.toFixed(1)}ms`,
  );
}

async function explainCompletedLookup(
  db: PrismaClient,
  input: { scopeId: string; syncRunId: string; start: Date; end: Date },
): Promise<ExplainSummary> {
  const rows = await db.$queryRawUnsafe<Array<{ 'QUERY PLAN': unknown }>>(
    `
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "completedAt"
      FROM "WorkItem"
      WHERE "scopeId" = $1
        AND "completedAt" IS NOT NULL
        AND "completedAt" >= $2
        AND "completedAt" <= $3
        AND "excludedReason" IS NULL
        AND "lastSyncRunId" = $4
      ORDER BY "completedAt" ASC
    `,
    input.scopeId,
    input.start,
    input.end,
    input.syncRunId,
  );

  const rawPlan = rows[0]?.['QUERY PLAN'];
  const planRoot = Array.isArray(rawPlan) ? rawPlan[0] : undefined;
  const plan = isRecord(planRoot) ? planRoot : {};
  const relationNodes: string[] = [];
  collectPlanNodes(plan['Plan'], relationNodes);
  return {
    planningMs: typeof plan['Planning Time'] === 'number' ? plan['Planning Time'] : undefined,
    executionMs: typeof plan['Execution Time'] === 'number' ? plan['Execution Time'] : undefined,
    topNode: isRecord(plan['Plan']) && typeof plan['Plan']['Node Type'] === 'string' ? plan['Plan']['Node Type'] : undefined,
    relationNodes,
  };
}

function collectPlanNodes(node: unknown, output: string[]): void {
  if (!isRecord(node)) return;
  const nodeType = typeof node['Node Type'] === 'string' ? node['Node Type'] : 'Unknown';
  const indexName = typeof node['Index Name'] === 'string' ? `:${node['Index Name']}` : '';
  const relationName = typeof node['Relation Name'] === 'string' ? `:${node['Relation Name']}` : '';
  output.push(`${nodeType}${relationName}${indexName}`);
  const plans = node['Plans'];
  if (Array.isArray(plans)) {
    for (const child of plans) collectPlanNodes(child, output);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatOptionalMs(value: number | undefined): string {
  return value === undefined ? 'unknown' : `${value.toFixed(3)}ms`;
}

function parseCompletedCounts(value: string): number[] {
  const counts = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((count) => Number.isInteger(count) && count > 0);
  if (counts.length === 0) {
    throw new Error('PERF_COMPLETED_COUNTS must contain at least one positive integer');
  }
  return counts;
}
