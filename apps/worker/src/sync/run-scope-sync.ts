import type { PrismaClient } from '@agile-tools/db';
import { DEFAULT_COMPLETED_WINDOW_DAYS } from '@agile-tools/db';
import {
  getConfig,
  decryptSecret,
  logger,
  metricsClock,
  recordSyncRun,
} from '@agile-tools/shared';
import type { JiraClient } from '@agile-tools/jira-client';
import {
  JiraClientError,
  createJiraClient,
  getBoardDetailWithFilterId,
  streamBoardIssues,
  streamJqlIssues,
  fetchIssueChangelog,
} from '@agile-tools/jira-client';
import type { RawJiraIssue } from '@agile-tools/jira-client';
import { detectBoardDrift, applyBoardDriftHandling } from './detect-board-drift.js';
import { updateConnectionHealthAfterSync } from './update-connection-health.js';
import {
  normalizeJiraIssue,
  type NormalizeContext,
  type NormalizedWorkItem,
} from './normalize-jira-issues.js';
import { rebuildScopeProjections } from '../projections/rebuild-scope-summary.js';

const BATCH_SIZE = 10;
const STAGED_ITEM_PAGE_SIZE = 100;
const COMPLETED_ISSUE_SEARCH_FIELDS = 'summary,status,issuetype,project,created,assignee';

class SyncError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

async function touchRunningSyncRun(
  db: PrismaClient,
  syncRunId: string,
  startedAt: Date,
): Promise<boolean> {
  const touched = await db.syncRun.updateMany({
    where: { id: syncRunId, status: 'running' },
    // Rewriting the claimed startedAt leaves the start timestamp stable while
    // still advancing updatedAt, which we use as the running-sync heartbeat.
    data: { startedAt },
  });

  return touched.count > 0;
}

async function requireRunningSyncRun(
  db: PrismaClient,
  syncRunId: string,
  startedAt: Date,
): Promise<void> {
  const stillRunning = await touchRunningSyncRun(db, syncRunId, startedAt);
  if (!stillRunning) {
    throw new SyncError('SYNC_RUN_ABORTED', `SyncRun ${syncRunId} is no longer running`);
  }
}

async function finalizeRunningSyncRun(
  db: PrismaClient,
  syncRunId: string,
  data: {
    status: 'canceled' | 'failed' | 'succeeded';
    finishedAt: Date;
    dataVersion?: string;
    errorCode?: string;
    errorSummary?: string;
  },
): Promise<boolean> {
  const finalized = await db.syncRun.updateMany({
    where: { id: syncRunId, status: 'running' },
    data,
  });

  if (finalized.count === 0) {
    logger.warn('SyncRun left running state before terminal update; skipping', {
      syncRunId,
      nextStatus: data.status,
    });
    return false;
  }

  return true;
}

async function cleanupStagedWorkItems(db: PrismaClient, syncRunId: string): Promise<void> {
  await db.syncWorkItemStage.deleteMany({ where: { syncRunId } }).catch((cleanupErr: unknown) => {
    logger.warn('Failed to clean up staged work items', {
      syncRunId,
      error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
    });
  });
}

/**
 * Execute the full Jira sync pipeline for a single scope.
 *
 * The caller is responsible for ensuring a SyncRun row exists in `queued` status.
 * This function atomically transitions the run to `running` via an updateMany guard,
 * and on completion updates it to `succeeded` or `failed`.
 */
export async function runScopeSync(db: PrismaClient, syncRunId: string): Promise<void> {
  const syncStartedAt = metricsClock.now();
  const syncRun = await db.syncRun.findUnique({ where: { id: syncRunId } });
  if (!syncRun) {
    logger.error('SyncRun not found; skipping', { syncRunId });
    recordSyncRun({
      trigger: 'unknown',
      result: 'skipped',
      errorCode: 'SYNC_RUN_NOT_FOUND',
      durationSeconds: metricsClock.durationSecondsSince(syncStartedAt),
      itemCount: 0,
    });
    return;
  }
  const trigger = syncRun.trigger;
  let metricRecorded = false;

  function recordSyncMetric(result: string, errorCode?: string, itemCount = 0): void {
    if (metricRecorded) return;
    metricRecorded = true;
    recordSyncRun({
      trigger,
      result,
      durationSeconds: metricsClock.durationSecondsSince(syncStartedAt),
      itemCount,
      ...(errorCode !== undefined ? { errorCode } : {}),
    });
  }

  const claimedStartedAt = new Date();

  // Atomically claim: only advance if still in queued state, preventing duplicate execution.
  const claimed = await db.syncRun.updateMany({
    where: { id: syncRunId, status: 'queued' },
    data: { status: 'running', startedAt: claimedStartedAt },
  });
  if (claimed.count === 0) {
    logger.warn('SyncRun is not in queued state; skipping', {
      syncRunId,
      currentStatus: syncRun.status,
    });
    recordSyncMetric('skipped', 'SYNC_RUN_NOT_QUEUED');
    return;
  }
  await cleanupStagedWorkItems(db, syncRunId);

  // Track connection context so the catch block can update health even on early errors.
  let scopeWorkspaceId: string | undefined;
  let scopeConnectionId: string | undefined;

  try {
    const scope = await db.flowScope.findUnique({ where: { id: syncRun.scopeId } });
    if (!scope) {
      throw new SyncError('SCOPE_NOT_FOUND', `FlowScope ${syncRun.scopeId} not found`);
    }

    scopeWorkspaceId = scope.workspaceId;
    scopeConnectionId = scope.connectionId;

    if (scope.status !== 'active') {
      const canceled = await finalizeRunningSyncRun(db, syncRunId, {
        status: 'canceled',
        finishedAt: new Date(),
        errorCode: 'SCOPE_NOT_ACTIVE',
      });
      if (!canceled) {
        return;
      }
      logger.info('Scope sync canceled: scope is not active', {
        syncRunId,
        scopeId: scope.id,
        scopeStatus: scope.status,
      });
      recordSyncMetric('canceled', 'SCOPE_NOT_ACTIVE');
      return;
    }

    const connection = await db.jiraConnection.findFirst({
      where: { id: scope.connectionId, workspaceId: scope.workspaceId },
    });
    if (!connection) {
      throw new SyncError(
        'CONNECTION_NOT_FOUND',
        `JiraConnection ${scope.connectionId} not found`,
      );
    }

    const { ENCRYPTION_KEY } = getConfig();
    const pat = decryptSecret(connection.encryptedSecretRef, ENCRYPTION_KEY);
    const jiraClient = createJiraClient(connection.baseUrl, pat);

    const boardId = Number(scope.boardId);
    const { detail: boardDetail, filterId: boardFilterId } = await getBoardDetailWithFilterId(
      jiraClient,
      boardId,
    );
    await requireRunningSyncRun(db, syncRunId, claimedStartedAt);

    // Abort early if the board layout has drifted away from the scope's configured statuses.
    // Continuing would produce incorrect lifecycle data (startedAt/completedAt derivation
    // depends on startStatusIds/doneStatusIds matching real board statuses).
    const drift = detectBoardDrift(scope, boardDetail);
    if (drift) {
      await applyBoardDriftHandling(db, scope, drift);
      const canceled = await finalizeRunningSyncRun(db, syncRunId, {
        status: 'canceled',
        finishedAt: new Date(),
        errorCode: 'BOARD_DRIFT_DETECTED',
      });
      if (!canceled) {
        return;
      }
      logger.info('Scope sync canceled due to board drift', { syncRunId, scopeId: scope.id });
      recordSyncMetric('canceled', 'BOARD_DRIFT_DETECTED');
      return;
    }

    // Build inverted status → column lookup from board configuration.
    const statusIdsByColumn: Record<string, string> = {};
    const inScopeStatusIds = new Set<string>(scope.doneStatusIds);
    const startStatusIds = new Set<string>(scope.startStatusIds);
    let reachedStartColumn = false;
    for (const col of boardDetail.columns) {
      for (const statusId of col.statusIds) {
        statusIdsByColumn[statusId] = col.name;
        if (!reachedStartColumn && startStatusIds.has(statusId)) {
          reachedStartColumn = true;
        }
        if (reachedStartColumn) {
          inScopeStatusIds.add(statusId);
        }
      }
    }

    // Create the BoardSnapshot upfront; projectRefs are backfilled after streaming.
    const snapshot = await db.boardSnapshot.create({
      data: {
        scopeId: scope.id,
        syncRunId,
        fetchedAt: new Date(),
        columns: boardDetail.columns,
        statusIdsByColumn,
        projectRefs: [],
      },
    });
    await requireRunningSyncRun(db, syncRunId, claimedStartedAt);

    const ctx: NormalizeContext = {
      scopeId: scope.id,
      syncRunId,
      startStatusIds,
      doneStatusIds: new Set(scope.doneStatusIds),
      inScopeStatusIds,
      includedIssueTypeIds: new Set(scope.includedIssueTypeIds),
      statusIdsByColumn,
      jiraBaseUrl: connection.baseUrl,
    };

    // Stream and process issues in fixed-size batches to bound memory and exploit
    // parallelism in changelog fetching (the Jira client's internal pLimit throttles HTTP).
    let batch: RawJiraIssue[] = [];
    const projectIdsSet = new Set<string>();
    const processedIssueIds = new Set<string>();

    for await (const issue of streamBoardIssues(jiraClient, boardId)) {
      if (processedIssueIds.has(issue.id)) {
        continue;
      }
      processedIssueIds.add(issue.id);
      batch.push(issue);
      if (batch.length >= BATCH_SIZE) {
        await processBatch(db, jiraClient, batch, ctx, projectIdsSet);
        await requireRunningSyncRun(db, syncRunId, claimedStartedAt);
        batch = [];
      }
    }
    if (batch.length > 0) {
      await processBatch(db, jiraClient, batch, ctx, projectIdsSet);
      await requireRunningSyncRun(db, syncRunId, claimedStartedAt);
      batch = [];
    }

    // Fetch historically-completed issues that match the board's saved filter but are
    // no longer visible on the board (because done statuses are not mapped to columns).
    // The board endpoint only returns issues whose status is mapped to a column, so
    // without this second pass the aging threshold model has no completed samples.
    if (scope.doneStatusIds.length > 0) {
      if (boardFilterId != null) {
        const doneIdList = scope.doneStatusIds.map((id: string) => `"${id}"`).join(', ');
        const completedJql =
          `filter = ${boardFilterId} AND status in (${doneIdList}) ` +
          `AND updated >= -${DEFAULT_COMPLETED_WINDOW_DAYS}d`;

        for await (const issue of streamJqlIssues(jiraClient, completedJql, {
          fields: COMPLETED_ISSUE_SEARCH_FIELDS,
        })) {
          if (processedIssueIds.has(issue.id)) {
            continue;
          }
          processedIssueIds.add(issue.id);
          batch.push(issue);
          if (batch.length >= BATCH_SIZE) {
            await processBatch(db, jiraClient, batch, ctx, projectIdsSet);
            await requireRunningSyncRun(db, syncRunId, claimedStartedAt);
            batch = [];
          }
        }
        if (batch.length > 0) {
          await processBatch(db, jiraClient, batch, ctx, projectIdsSet);
          await requireRunningSyncRun(db, syncRunId, claimedStartedAt);
        }

        logger.info('Completed-issue sync pass finished', { syncRunId, scopeId: scope.id });
      } else {
        logger.warn('Board has no saved filter; skipping completed-issue sync pass', {
          syncRunId,
          boardId,
        });
      }
    }

    // Backfill BoardSnapshot with project refs collected from issue data.
    await db.boardSnapshot.update({
      where: { id: snapshot.id },
      data: { projectRefs: Array.from(projectIdsSet).map((id) => ({ id })) },
    });
    await requireRunningSyncRun(db, syncRunId, claimedStartedAt);

    // Use syncRunId as the dataVersion — it is already a UUID and unique per sync.
    const succeeded = await publishSyncedWorkItems(
      db,
      syncRunId,
      claimedStartedAt,
      scope.id,
    );
    if (!succeeded) {
      recordSyncMetric('skipped', 'SYNC_RUN_NOT_RUNNING', processedIssueIds.size);
      return;
    }

    // Rebuild projection data after the sync is marked as succeeded (non-blocking).
    await rebuildScopeProjections(db, scope.id, syncRunId).catch((rebuildErr: unknown) => {
      logger.warn('Projection rebuild failed after sync success', {
        syncRunId,
        scopeId: scope.id,
        error: rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr),
      });
    });

    // Mark connection healthy now that Jira was reachable and the sync succeeded.
    await updateConnectionHealthAfterSync(db, scope.workspaceId, scope.connectionId, {
      succeeded: true,
    }).catch((healthErr: unknown) => {
      logger.warn('Failed to update connection health after sync success', {
        connectionId: scope.connectionId,
        error: healthErr instanceof Error ? healthErr.message : String(healthErr),
      });
    });

    logger.info('Scope sync succeeded', {
      syncRunId,
      scopeId: scope.id,
      projectCount: projectIdsSet.size,
    });
    recordSyncMetric('succeeded', undefined, processedIssueIds.size);
  } catch (err) {
    // Map errors to deterministic codes so the health updater can classify failures.
    let errorCode: string;
    let errorSummary: string;

    if (err instanceof SyncError) {
      errorCode = err.code;
      errorSummary = err.message.slice(0, 500);
    } else if (err instanceof JiraClientError) {
      // 401/403 → auth failure; all other HTTP errors → generic transport failure.
      errorCode =
        err.code === 'unauthorized' || err.code === 'forbidden'
          ? 'JIRA_AUTH_ERROR'
          : 'JIRA_HTTP_ERROR';
      errorSummary = err.message.slice(0, 500);
    } else {
      errorCode = 'UNEXPECTED_ERROR';
      errorSummary = err instanceof Error ? err.message.slice(0, 500) : String(err);
    }

    try {
      const finalized = await finalizeRunningSyncRun(db, syncRunId, {
        status: 'failed',
        finishedAt: new Date(),
        errorCode,
        errorSummary,
      });
      if (!finalized) {
        await cleanupStagedWorkItems(db, syncRunId);
        return;
      }
      await cleanupStagedWorkItems(db, syncRunId);
    } catch (updateErr: unknown) {
      logger.error('Failed to update SyncRun to failed state', {
        syncRunId,
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    }

    // Update connection health only when we have context and the failure was Jira-related.
    if (scopeWorkspaceId && scopeConnectionId) {
      await updateConnectionHealthAfterSync(db, scopeWorkspaceId, scopeConnectionId, {
        succeeded: false,
        errorCode,
      }).catch((healthErr: unknown) => {
        logger.warn('Failed to update connection health after sync failure', {
          connectionId: scopeConnectionId,
          error: healthErr instanceof Error ? healthErr.message : String(healthErr),
        });
      });
    }

    logger.error('Scope sync failed', { syncRunId, errorCode, errorSummary });
    recordSyncMetric('failed', errorCode);
    throw err;
  }
}

/**
 * Fetch changelogs for a batch of issues concurrently, then normalize each item.
 * Concurrency for HTTP is bounded by the Jira client's internal pLimit.
 */
async function processBatch(
  db: PrismaClient,
  jiraClient: JiraClient,
  issues: RawJiraIssue[],
  ctx: NormalizeContext,
  projectIdsSet: Set<string>,
): Promise<void> {
  const changelogs = await Promise.all(
    issues.map((issue) => fetchIssueChangelog(jiraClient, issue.id)),
  );

  const normalizedItems = issues.map((issue, index) => {
    const normalized = normalizeJiraIssue(issue, changelogs[index]!, ctx);
    projectIdsSet.add(normalized.projectId);
    return normalized;
  });

  await stageWorkItems(db, ctx.scopeId, ctx.syncRunId, normalizedItems);
}

/**
 * JSONB staging representation of lifecycle events. Runtime normalization uses
 * Date instances, but staged rows serialize timestamps so Prisma can persist
 * them in the SyncWorkItemStage.lifecycleEvents JSON column.
 */
type StagedLifecycleEvent = Omit<NormalizedWorkItem['lifecycleEvents'][number], 'changedAt'> & {
  changedAt: string;
};

const LIFECYCLE_EVENT_TYPE_MAP: Record<StagedLifecycleEvent['eventType'], true> = {
  status_change: true,
  field_change: true,
  reopened: true,
  completed: true,
};
const LIFECYCLE_EVENT_TYPES = new Set<StagedLifecycleEvent['eventType']>(
  Object.keys(LIFECYCLE_EVENT_TYPE_MAP) as StagedLifecycleEvent['eventType'][],
);

function stageLifecycleEvents(
  events: NormalizedWorkItem['lifecycleEvents'],
): StagedLifecycleEvent[] {
  return events.map((event) => ({
    ...event,
    changedAt: event.changedAt.toISOString(),
  }));
}

function restoreLifecycleEvents(
  value: unknown,
  syncRunId: string,
  jiraIssueId: string,
): NormalizedWorkItem['lifecycleEvents'] {
  if (!Array.isArray(value)) {
    logger.warn('Ignoring invalid staged lifecycle events payload', { syncRunId, jiraIssueId });
    return [];
  }

  const restoredEvents: NormalizedWorkItem['lifecycleEvents'] = [];
  for (const event of value) {
    if (!isStagedLifecycleEvent(event)) {
      logger.warn('Ignoring malformed staged lifecycle event', {
        syncRunId,
        jiraIssueId,
        eventType: getStagedEventType(event),
      });
      continue;
    }
    restoredEvents.push({
      ...event,
      changedAt: new Date(event.changedAt),
    });
  }

  return restoredEvents;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function getStagedEventType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('eventType' in value)) {
    return undefined;
  }

  const eventType = (value as { eventType?: unknown }).eventType;
  if (
    typeof eventType === 'string' ||
    typeof eventType === 'number' ||
    typeof eventType === 'boolean'
  ) {
    return String(eventType);
  }
  return undefined;
}

function isStagedLifecycleEvent(value: unknown): value is StagedLifecycleEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const event = value as Partial<StagedLifecycleEvent>;
  return (
    typeof event.rawChangelogId === 'string' &&
    event.eventType !== undefined &&
    LIFECYCLE_EVENT_TYPES.has(event.eventType) &&
    isNullableString(event.fromStatusId) &&
    isNullableString(event.toStatusId) &&
    isNullableString(event.changedFieldId) &&
    typeof event.changedAt === 'string' &&
    !Number.isNaN(Date.parse(event.changedAt))
  );
}

async function stageWorkItems(
  db: PrismaClient,
  scopeId: string,
  syncRunId: string,
  items: NormalizedWorkItem[],
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  await db.syncWorkItemStage.createMany({
    data: items.map((item) => ({
      syncRunId,
      scopeId,
      jiraIssueId: item.jiraIssueId,
      issueKey: item.issueKey,
      summary: item.summary,
      issueTypeId: item.issueTypeId,
      issueTypeName: item.issueTypeName,
      projectId: item.projectId,
      currentStatusId: item.currentStatusId,
      currentStatusName: item.currentStatusName,
      currentColumn: item.currentColumn,
      assigneeName: item.assigneeName,
      jiraCreatedAt: item.createdAt,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      reopenedCount: item.reopenedCount,
      directUrl: item.directUrl,
      excludedReason: item.excludedReason,
      lifecycleEvents: stageLifecycleEvents(item.lifecycleEvents),
    })),
    skipDuplicates: true,
  });
}

async function publishSyncedWorkItems(
  db: PrismaClient,
  syncRunId: string,
  startedAt: Date,
  scopeId: string,
): Promise<boolean> {
  const {
    SYNC_PUBLISH_TRANSACTION_TIMEOUT_MS: publishTimeoutMs,
    SYNC_PUBLISH_TRANSACTION_MAX_WAIT_MS: publishMaxWaitMs,
  } = getConfig();
  // The publish transaction is intentionally atomic: Flow analytics queries pin
  // to the last succeeded SyncRun's dataVersion (= syncRunId), so the previous
  // version remains fully visible until this transaction commits. Prisma's
  // default 5 s interactive transaction timeout is not enough for large boards,
  // so we raise it via config. The runtime is still bounded by the finite set
  // of staged items.
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "SyncRun"
      WHERE id = ${syncRunId}
        AND status = 'running'
      FOR UPDATE
    `;
    if (rows.length === 0) {
      logger.warn('SyncRun left running state before publish; skipping', {
        syncRunId,
      });
      await tx.syncWorkItemStage.deleteMany({ where: { syncRunId } });
      return false;
    }
    await tx.$executeRaw`
      UPDATE "SyncRun"
      SET "startedAt" = ${startedAt}, "updatedAt" = NOW()
      WHERE id = ${syncRunId}
        AND status = 'running'
    `;

    const syncedAt = new Date();
    let lastStageId: string | undefined;

    for (;;) {
      const stagedItems = await tx.syncWorkItemStage.findMany({
        where: { syncRunId },
        orderBy: { id: 'asc' },
        take: STAGED_ITEM_PAGE_SIZE,
        ...(lastStageId ? { cursor: { id: lastStageId }, skip: 1 } : {}),
      });

      if (stagedItems.length === 0) {
        break;
      }

      for (const item of stagedItems) {
        const workItem = await tx.workItem.upsert({
          where: { scopeId_jiraIssueId: { scopeId, jiraIssueId: item.jiraIssueId } },
          create: {
            scopeId,
            jiraIssueId: item.jiraIssueId,
            issueKey: item.issueKey,
            summary: item.summary,
            issueTypeId: item.issueTypeId,
            issueTypeName: item.issueTypeName,
            projectId: item.projectId,
            currentStatusId: item.currentStatusId,
            currentStatusName: item.currentStatusName,
            currentColumn: item.currentColumn,
            assigneeName: item.assigneeName,
            createdAt: item.jiraCreatedAt,
            startedAt: item.startedAt,
            completedAt: item.completedAt,
            reopenedCount: item.reopenedCount,
            directUrl: item.directUrl,
            excludedReason: item.excludedReason,
            syncedAt,
            lastSyncRunId: syncRunId,
          },
          update: {
            issueKey: item.issueKey,
            summary: item.summary,
            issueTypeId: item.issueTypeId,
            issueTypeName: item.issueTypeName,
            projectId: item.projectId,
            currentStatusId: item.currentStatusId,
            currentStatusName: item.currentStatusName,
            currentColumn: item.currentColumn,
            assigneeName: item.assigneeName,
            startedAt: item.startedAt,
            completedAt: item.completedAt,
            reopenedCount: item.reopenedCount,
            directUrl: item.directUrl,
            excludedReason: item.excludedReason,
            syncedAt,
            lastSyncRunId: syncRunId,
          },
        });

        const restoredLifecycleEvents = restoreLifecycleEvents(
          item.lifecycleEvents,
          syncRunId,
          item.jiraIssueId,
        );
        if (restoredLifecycleEvents.length > 0) {
          await tx.workItemLifecycleEvent.createMany({
            data: restoredLifecycleEvents.map((event) => ({
              workItemId: workItem.id,
              rawChangelogId: event.rawChangelogId,
              eventType: event.eventType,
              fromStatusId: event.fromStatusId,
              toStatusId: event.toStatusId,
              changedFieldId: event.changedFieldId,
              changedAt: event.changedAt,
            })),
            skipDuplicates: true,
          });
        }
      }

      lastStageId = stagedItems.at(-1)?.id;
    }

    await tx.syncWorkItemStage.deleteMany({ where: { syncRunId } });

    await tx.syncRun.updateMany({
      where: { id: syncRunId, status: 'running' },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        dataVersion: syncRunId,
      },
    });

    return true;
  }, { timeout: publishTimeoutMs, maxWait: publishMaxWaitMs });
}
