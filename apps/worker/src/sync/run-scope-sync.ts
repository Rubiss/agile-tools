import type { PrismaClient } from '@agile-tools/db';
import { DEFAULT_COMPLETED_WINDOW_DAYS } from '@agile-tools/db';
import { getConfig, decryptSecret, logger } from '@agile-tools/shared';
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

/**
 * Execute the full Jira sync pipeline for a single scope.
 *
 * The caller is responsible for ensuring a SyncRun row exists in `queued` status.
 * This function atomically transitions the run to `running` via an updateMany guard,
 * and on completion updates it to `succeeded` or `failed`.
 */
export async function runScopeSync(db: PrismaClient, syncRunId: string): Promise<void> {
  const syncRun = await db.syncRun.findUnique({ where: { id: syncRunId } });
  if (!syncRun) {
    logger.error('SyncRun not found; skipping', { syncRunId });
    return;
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
    return;
  }

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
      return;
    }

    // Build inverted status → column lookup from board configuration.
    const statusIdsByColumn: Record<string, string> = {};
    for (const col of boardDetail.columns) {
      for (const statusId of col.statusIds) {
        statusIdsByColumn[statusId] = col.name;
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
      startStatusIds: new Set(scope.startStatusIds),
      doneStatusIds: new Set(scope.doneStatusIds),
      includedIssueTypeIds: new Set(scope.includedIssueTypeIds),
      statusIdsByColumn,
      jiraBaseUrl: connection.baseUrl,
    };

    // Stream and process issues in fixed-size batches to bound memory and exploit
    // parallelism in changelog fetching (the Jira client's internal pLimit throttles HTTP).
    let batch: RawJiraIssue[] = [];
    const syncedItems: NormalizedWorkItem[] = [];
    const projectIdsSet = new Set<string>();
    const processedIssueIds = new Set<string>();

    for await (const issue of streamBoardIssues(jiraClient, boardId)) {
      if (processedIssueIds.has(issue.id)) {
        continue;
      }
      processedIssueIds.add(issue.id);
      batch.push(issue);
      if (batch.length >= BATCH_SIZE) {
        syncedItems.push(...(await processBatch(jiraClient, batch, ctx, projectIdsSet)));
        await requireRunningSyncRun(db, syncRunId, claimedStartedAt);
        batch = [];
      }
    }
    if (batch.length > 0) {
      syncedItems.push(...(await processBatch(jiraClient, batch, ctx, projectIdsSet)));
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
            syncedItems.push(...(await processBatch(jiraClient, batch, ctx, projectIdsSet)));
            await requireRunningSyncRun(db, syncRunId, claimedStartedAt);
            batch = [];
          }
        }
        if (batch.length > 0) {
          syncedItems.push(...(await processBatch(jiraClient, batch, ctx, projectIdsSet)));
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
      syncedItems,
    );
    if (!succeeded) {
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
        return;
      }
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
    throw err;
  }
}

/**
 * Fetch changelogs for a batch of issues concurrently, then normalize each item.
 * Concurrency for HTTP is bounded by the Jira client's internal pLimit.
 */
async function processBatch(
  jiraClient: JiraClient,
  issues: RawJiraIssue[],
  ctx: NormalizeContext,
  projectIdsSet: Set<string>,
): Promise<NormalizedWorkItem[]> {
  const changelogs = await Promise.all(
    issues.map((issue) => fetchIssueChangelog(jiraClient, issue.id)),
  );

  return issues.map((issue, index) => {
    const normalized = normalizeJiraIssue(issue, changelogs[index]!, ctx);
    projectIdsSet.add(normalized.projectId);
    return normalized;
  });
}

async function publishSyncedWorkItems(
  db: PrismaClient,
  syncRunId: string,
  startedAt: Date,
  scopeId: string,
  items: NormalizedWorkItem[],
): Promise<boolean> {
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
      return false;
    }
    await tx.$executeRaw`
      UPDATE "SyncRun"
      SET "startedAt" = ${startedAt}, "updatedAt" = NOW()
      WHERE id = ${syncRunId}
        AND status = 'running'
    `;

    const syncedAt = new Date();
    for (const item of items) {
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
          createdAt: item.createdAt,
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

      if (item.lifecycleEvents.length > 0) {
        await tx.workItemLifecycleEvent.createMany({
          data: item.lifecycleEvents.map((event) => ({
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

    await tx.syncRun.updateMany({
      where: { id: syncRunId, status: 'running' },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        dataVersion: syncRunId,
      },
    });

    return true;
  });
}
