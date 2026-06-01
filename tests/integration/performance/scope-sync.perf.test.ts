/**
 * Real Jira sync benchmark.
 *
 * This benchmark expects the local Docker stack to be running and the local Jira
 * bootstrap file to point at a board with 1000+ completed stories. It runs the
 * worker sync pipeline directly, not through pg-boss, so the measured duration
 * is the Jira read + staging + publish + projection rebuild time.
 *
 * Recommended setup:
 *   $env:JIRA_BOOTSTRAP_SAMPLE_ISSUE_COUNT='1010'
 *   $env:JIRA_BOOTSTRAP_COMPLETED_STORY_COUNT='1000'
 *   $env:JIRA_BOOTSTRAP_IN_PROGRESS_STORY_COUNT='10'
 *   $env:JIRA_BOOTSTRAP_RESET_ISSUES='true'
 *   docker compose -f docker-compose.jira.yml --profile bootstrap run --rm jira-bootstrap
 *
 * Run:
 *   $env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/agile_tools'
 *   pnpm exec vitest run --config tests/integration/performance/vitest.config.ts tests/integration/performance/scope-sync.perf.test.ts --reporter verbose
 */

import fs from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrismaClient, type PrismaClient } from '@agile-tools/db';
import {
  createJiraClient,
  getBoardDetailWithFilterId,
  streamJqlIssues,
} from '@agile-tools/jira-client';
import { encryptSecret, resetConfig } from '@agile-tools/shared';
import { runScopeSync } from '../../../apps/worker/src/sync/run-scope-sync';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/agile_tools';
const ENCRYPTION_KEY = process.env['ENCRYPTION_KEY'] ?? 'local-dev-encryption-key-32-chars-minimum-001';
const BOOTSTRAP_OUTPUT_PATH = process.env['JIRA_BOOTSTRAP_OUTPUT_PATH'] ?? '.jira-local/jira-bootstrap.json';
const MIN_COMPLETED_STORIES = Number(process.env['PERF_SYNC_MIN_COMPLETED_STORIES'] ?? '1000');
const SYNC_BUDGET_MS = Number(process.env['PERF_SYNC_BUDGET_MS'] ?? '600000');

interface JiraBootstrapOutput {
  agileToolsConnection: {
    baseUrl: string;
    boardId: number;
    token: string;
  };
}

interface SyncBenchmarkScope {
  workspaceId: string;
  connectionId: string;
  scopeId: string;
  syncRunId: string;
  expectedCompletedStories: number;
}

let benchmarkScope: SyncBenchmarkScope | undefined;

beforeAll(async () => {
  process.env['DATABASE_URL'] = DATABASE_URL;
  process.env['ENCRYPTION_KEY'] = ENCRYPTION_KEY;
  process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';
  process.env['LOG_LEVEL'] = process.env['LOG_LEVEL'] ?? 'warn';
  resetConfig();
  await disconnectPrisma();

  const bootstrap = await readBootstrapOutput();
  const db = getPrismaClient();
  benchmarkScope = await createBenchmarkScope(db, bootstrap);
}, 120_000);

afterAll(async () => {
  const db = getPrismaClient();
  if (benchmarkScope?.workspaceId) {
    await db.workspace.delete({ where: { id: benchmarkScope.workspaceId } }).catch(() => undefined);
  }
  await disconnectPrisma();
}, 120_000);

describe('runScopeSync real Jira benchmark', () => {
  it(`syncs a local Jira board with ${MIN_COMPLETED_STORIES}+ completed stories`, async () => {
    if (!benchmarkScope) throw new Error('Benchmark scope was not initialized');
    const db = getPrismaClient();

    const startedAt = performance.now();
    await runScopeSync(db, benchmarkScope.syncRunId);
    const elapsedMs = performance.now() - startedAt;

    const [syncRun, rowCounts] = await Promise.all([
      db.syncRun.findUniqueOrThrow({ where: { id: benchmarkScope.syncRunId } }),
      getSyncRowCounts(db, benchmarkScope.scopeId, benchmarkScope.syncRunId),
    ]);

    const dbStartedAt = syncRun.startedAt;
    const dbFinishedAt = syncRun.finishedAt;
    const dbElapsedMs =
      dbStartedAt && dbFinishedAt ? dbFinishedAt.getTime() - dbStartedAt.getTime() : undefined;

    console.info(
      [
        `[sync-perf] status=${syncRun.status}`,
        `wall=${elapsedMs.toFixed(1)}ms`,
        `syncRunDuration=${dbElapsedMs === undefined ? 'unknown' : `${dbElapsedMs}ms`}`,
        `expectedCompleted=${benchmarkScope.expectedCompletedStories}`,
        `workItems=${rowCounts.workItems}`,
        `completed=${rowCounts.completedWorkItems}`,
        `active=${rowCounts.activeWorkItems}`,
        `lifecycleEvents=${rowCounts.lifecycleEvents}`,
        `holdPeriods=${rowCounts.holdPeriods}`,
        `agingModels=${rowCounts.agingModels}`,
        `stagedRemaining=${rowCounts.stagedRemaining}`,
      ].join(' '),
    );

    expect(syncRun.status).toBe('succeeded');
    expect(rowCounts.completedWorkItems).toBeGreaterThanOrEqual(MIN_COMPLETED_STORIES);
    expect(rowCounts.stagedRemaining).toBe(0);
    expect(elapsedMs).toBeLessThan(SYNC_BUDGET_MS);
  }, 900_000);
});

async function readBootstrapOutput(): Promise<JiraBootstrapOutput> {
  const raw = await fs.readFile(BOOTSTRAP_OUTPUT_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Partial<JiraBootstrapOutput>;
  if (
    !parsed.agileToolsConnection?.baseUrl ||
    !parsed.agileToolsConnection.token ||
    typeof parsed.agileToolsConnection.boardId !== 'number'
  ) {
    throw new Error(`Invalid Jira bootstrap output at ${BOOTSTRAP_OUTPUT_PATH}`);
  }
  return parsed as JiraBootstrapOutput;
}

async function createBenchmarkScope(
  db: PrismaClient,
  bootstrap: JiraBootstrapOutput,
): Promise<SyncBenchmarkScope> {
  const { baseUrl, token, boardId } = bootstrap.agileToolsConnection;
  const jiraClient = createJiraClient(baseUrl, token);
  const { detail, filterId } = await getBoardDetailWithFilterId(jiraClient, boardId);
  if (!filterId) {
    throw new Error(`Board ${boardId} does not expose a saved filter id`);
  }

  const doneColumn = detail.columns.find((column) => column.name.toLowerCase() === 'done');
  const doneStatusId = doneColumn?.statusIds[0];
  if (!doneStatusId) {
    throw new Error(`Board ${boardId} does not expose a Done column status`);
  }

  const firstNonDoneColumn = detail.columns.find(
    (column) => column.statusIds.length > 0 && !column.statusIds.includes(doneStatusId),
  );
  if (!firstNonDoneColumn || firstNonDoneColumn.statusIds.length === 0) {
    throw new Error(`Board ${boardId} does not expose a non-Done start column`);
  }

  const storyType = detail.issueTypes.find((type) => type.name.toLowerCase() === 'story');
  if (!storyType) {
    throw new Error(`Board ${boardId} does not expose Story as an issue type`);
  }

  const expectedCompletedStories = await countCompletedStories(jiraClient, filterId, doneStatusId);
  if (expectedCompletedStories < MIN_COMPLETED_STORIES) {
    throw new Error(
      `Local Jira board has ${expectedCompletedStories} completed stories; expected at least ${MIN_COMPLETED_STORIES}. Re-run jira-bootstrap with a larger JIRA_BOOTSTRAP_COMPLETED_STORY_COUNT.`,
    );
  }

  const workspace = await db.workspace.create({
    data: {
      name: `Sync Perf ${new Date().toISOString()}`,
      defaultTimezone: 'UTC',
    },
  });
  const connection = await db.jiraConnection.create({
    data: {
      workspaceId: workspace.id,
      baseUrl,
      displayName: 'Local Jira Sync Perf',
      authType: 'pat',
      encryptedSecretRef: encryptSecret(token, ENCRYPTION_KEY),
      healthStatus: 'healthy',
      lastValidatedAt: new Date(),
      lastHealthyAt: new Date(),
    },
  });
  const scope = await db.flowScope.create({
    data: {
      workspaceId: workspace.id,
      connectionId: connection.id,
      boardId: String(boardId),
      boardName: detail.boardName,
      timezone: 'UTC',
      includedIssueTypeIds: [storyType.id],
      includedIssueTypeNames: [storyType.name],
      startStatusIds: [firstNonDoneColumn.statusIds[0]!],
      doneStatusIds: [doneStatusId],
      syncIntervalMinutes: 10,
    },
  });
  const syncRun = await db.syncRun.create({
    data: {
      scopeId: scope.id,
      trigger: 'manual',
      status: 'queued',
      requestedBy: 'perf-benchmark',
    },
  });

  return {
    workspaceId: workspace.id,
    connectionId: connection.id,
    scopeId: scope.id,
    syncRunId: syncRun.id,
    expectedCompletedStories,
  };
}

async function countCompletedStories(
  jiraClient: ReturnType<typeof createJiraClient>,
  filterId: string,
  doneStatusId: string,
): Promise<number> {
  let count = 0;
  for await (const issue of streamJqlIssues(jiraClient, `filter = ${filterId} AND status in ("${doneStatusId}")`, {
    fields: 'summary,status,issuetype,project,created,assignee',
  })) {
    if (issue.fields.issuetype?.name === 'Story') {
      count += 1;
    }
  }
  return count;
}

async function getSyncRowCounts(
  db: PrismaClient,
  scopeId: string,
  syncRunId: string,
): Promise<{
  workItems: number;
  completedWorkItems: number;
  activeWorkItems: number;
  lifecycleEvents: number;
  holdPeriods: number;
  agingModels: number;
  stagedRemaining: number;
}> {
  const [
    workItems,
    completedWorkItems,
    activeWorkItems,
    lifecycleEvents,
    holdPeriods,
    agingModels,
    stagedRemaining,
  ] = await Promise.all([
    db.workItem.count({ where: { scopeId, lastSyncRunId: syncRunId } }),
    db.workItem.count({ where: { scopeId, lastSyncRunId: syncRunId, completedAt: { not: null } } }),
    db.workItem.count({ where: { scopeId, lastSyncRunId: syncRunId, completedAt: null } }),
    db.workItemLifecycleEvent.count({ where: { workItem: { scopeId, lastSyncRunId: syncRunId } } }),
    db.holdPeriod.count({ where: { workItem: { scopeId, lastSyncRunId: syncRunId } } }),
    db.agingThresholdModel.count({ where: { scopeId, dataVersion: syncRunId } }),
    db.syncWorkItemStage.count({ where: { scopeId, syncRunId } }),
  ]);

  return {
    workItems,
    completedWorkItems,
    activeWorkItems,
    lifecycleEvents,
    holdPeriods,
    agingModels,
    stagedRemaining,
  };
}
