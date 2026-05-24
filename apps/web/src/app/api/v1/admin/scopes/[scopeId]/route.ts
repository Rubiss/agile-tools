import { type NextRequest } from 'next/server';
import {
  acquireScopeSyncLock,
  createSyncRun,
  deleteFlowScope,
  getFlowScope,
  getJiraConnection,
  getPrismaClient,
  resolveActiveSyncRun,
  updateFlowScope,
  updateSyncRun,
} from '@agile-tools/db';
import { logger } from '@agile-tools/shared';
import { type NamedValue, UpdateFlowScopeRequestSchema } from '@agile-tools/shared/contracts/api';
import { getBoardDetail } from '@agile-tools/jira-client';
import { z } from 'zod';
import { requireAdminContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { assertTrustedMutationRequest, enforceRateLimit } from '@/server/request-security';
import { createClientForConnection, normalizeJiraError } from '../../jira-connections/_lib';
import {
  buildIncludedIssueTypes,
  formatIssueDetails,
  hasNamesForAllIds,
  mapScope,
  parseStoredStringArray,
  selectNamedValues,
} from '../_lib';
import { enqueueScopeSyncJob } from '@/server/queue';
import { withHttpMetrics } from '@/server/route-metrics';

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  if (leftSet.size !== new Set(right).size) return false;
  return right.every((value) => leftSet.has(value));
}

function sameStringSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type ScopeUpdatePayload = z.infer<typeof UpdateFlowScopeRequestSchema>;

function hasBoundaryChanges(scope: {
  connectionId: string;
  boardId: string;
  timezone: string;
  includedIssueTypeIds: string[];
  startStatusIds: string[];
  doneStatusIds: string[];
}, input: ScopeUpdatePayload): boolean {
  return (
    scope.connectionId !== input.connectionId ||
    scope.boardId !== String(input.boardId) ||
    scope.timezone !== input.timezone ||
    !sameStringSet(scope.includedIssueTypeIds, input.includedIssueTypeIds) ||
    !sameStringSet(scope.startStatusIds, input.startStatusIds) ||
    !sameStringSet(scope.doneStatusIds, input.doneStatusIds)
  );
}

function hasBoardSelectionChange(scope: {
  connectionId: string;
  boardId: string;
}, input: ScopeUpdatePayload): boolean {
  return scope.connectionId !== input.connectionId || scope.boardId !== String(input.boardId);
}

function hasIssueTypeSelectionChange(scope: {
  includedIssueTypeIds: string[];
}, input: ScopeUpdatePayload): boolean {
  return !sameStringSequence(scope.includedIssueTypeIds, input.includedIssueTypeIds);
}

function matchesQueuedScopeForRollback(
  scope: {
    connectionId: string;
    boardId: string;
    timezone: string;
    includedIssueTypeIds: string[];
    includedIssueTypeNames: string[];
    startStatusIds: string[];
    doneStatusIds: string[];
  },
  queued: {
    connectionId: string;
    boardId: string;
    timezone: string;
    includedIssueTypeIds: string[];
    includedIssueTypeNames: string[];
    startStatusIds: string[];
    doneStatusIds: string[];
  },
): boolean {
  return (
    scope.connectionId === queued.connectionId &&
    scope.boardId === queued.boardId &&
    scope.timezone === queued.timezone &&
    sameStringSequence(scope.includedIssueTypeIds, queued.includedIssueTypeIds) &&
    sameStringSequence(scope.includedIssueTypeNames, queued.includedIssueTypeNames) &&
    sameStringSet(scope.startStatusIds, queued.startStatusIds) &&
    sameStringSet(scope.doneStatusIds, queued.doneStatusIds)
  );
}

function toScopeUpdateInput(scope: {
  connectionId: string;
  boardId: string;
  boardName: string;
  timezone: string;
  includedIssueTypeIds: string[];
  includedIssueTypeNames: string[];
  startStatusIds: string[];
  doneStatusIds: string[];
  syncIntervalMinutes: number;
}) {
  return {
    connectionId: scope.connectionId,
    boardId: Number(scope.boardId),
    boardName: scope.boardName,
    timezone: scope.timezone,
    includedIssueTypeIds: scope.includedIssueTypeIds,
    includedIssueTypeNames: scope.includedIssueTypeNames,
    startStatusIds: scope.startStatusIds,
    doneStatusIds: scope.doneStatusIds,
    syncIntervalMinutes: scope.syncIntervalMinutes,
  };
}

function syncInProgressResponse(syncRunId: string): Response {
  return Response.json(
    {
      code: 'SYNC_IN_PROGRESS',
      message: 'Wait for the active sync to finish before changing board or flow boundaries.',
      syncRunId,
    },
    { status: 409 },
  );
}

async function handlePUT(
  req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireAdminContext();
    assertTrustedMutationRequest(req);
    enforceRateLimit(req, {
      bucket: 'admin-scopes:update',
      identifier: `${ctx.workspaceId}:${ctx.userId}:${(await params).scopeId}`,
      max: 20,
      windowMs: 5 * 60_000,
    });
    const { scopeId } = await params;

    const body: unknown = await req.json().catch(() => null);
    const parsed = UpdateFlowScopeRequestSchema.safeParse(body);
    if (!parsed.success) {
      const details = formatIssueDetails(parsed.error.issues);
      return Response.json(
        {
          code: 'INVALID_REQUEST',
          message: details[0] ?? 'Invalid request body.',
          details,
        },
        { status: 400 },
      );
    }

    const prisma = getPrismaClient();
    const preflightScope = await getFlowScope(prisma, ctx.workspaceId, scopeId);
    if (!preflightScope) {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Flow scope not found.' },
        { status: 404 },
      );
    }

    const preflightIncludedIssueTypeNames = parseStoredStringArray(
      preflightScope.includedIssueTypeNames,
      'includedIssueTypeNames',
    );
    const preflightIncludedIssueTypes = buildIncludedIssueTypes(
      preflightScope.includedIssueTypeIds,
      preflightIncludedIssueTypeNames,
    );
    const boardSelectionChanged = hasBoardSelectionChange(preflightScope, parsed.data);
    const issueTypeSelectionChanged = hasIssueTypeSelectionChange(preflightScope, parsed.data);
    const boundaryChangesRequested = hasBoundaryChanges(preflightScope, parsed.data);
    const needsIssueTypeLookup =
      boardSelectionChanged ||
      (issueTypeSelectionChanged &&
        !hasNamesForAllIds(parsed.data.includedIssueTypeIds, preflightIncludedIssueTypes));

    if (boundaryChangesRequested) {
      const preflightActiveRun = await prisma.$transaction(async (tx) => {
        await acquireScopeSyncLock(tx, scopeId);
        return resolveActiveSyncRun(tx, ctx.workspaceId, scopeId);
      });
      if (preflightActiveRun) {
        return syncInProgressResponse(preflightActiveRun.id);
      }
    }

    let prefetchedBoardName: string | null = null;
    let prefetchedIssueTypes: NamedValue[] = [];
    if (needsIssueTypeLookup) {
      const connection = await getJiraConnection(prisma, ctx.workspaceId, parsed.data.connectionId);
      if (!connection) {
        return Response.json(
          { code: 'NOT_FOUND', message: 'Jira connection not found.' },
          { status: 404 },
        );
      }

      const client = createClientForConnection(connection);
      try {
        const boardDetail = await getBoardDetail(client, parsed.data.boardId);
        prefetchedBoardName = boardDetail.boardName;
        prefetchedIssueTypes = boardDetail.issueTypes;
      } catch (err) {
        const jiraErr = normalizeJiraError(err);
        return Response.json(
          {
            code: jiraErr?.code ?? 'JIRA_ERROR',
            message: jiraErr?.message ?? 'Failed to fetch board details from Jira.',
          },
          { status: jiraErr?.statusCode === 404 ? 404 : 502 },
        );
      }
    }

    const txResult = await prisma.$transaction(async (tx) => {
      await acquireScopeSyncLock(tx, scopeId);

      const currentScope = await getFlowScope(tx, ctx.workspaceId, scopeId);
      if (!currentScope) {
        return { kind: 'missing' as const };
      }

      const rollbackScopeInput = toScopeUpdateInput(currentScope);
      const stillRequiresSync = hasBoundaryChanges(currentScope, parsed.data);

      if (stillRequiresSync) {
        const activeRun = await resolveActiveSyncRun(tx, ctx.workspaceId, scopeId);
        if (activeRun) {
          return { kind: 'active' as const, activeRunId: activeRun.id };
        }
      }

      const currentIncludedIssueTypeNames = parseStoredStringArray(
        currentScope.includedIssueTypeNames,
        'includedIssueTypeNames',
      );
      const currentIncludedIssueTypes = buildIncludedIssueTypes(
        currentScope.includedIssueTypeIds,
        currentIncludedIssueTypeNames,
      );

      let boardName = currentScope.boardName;
      if (hasBoardSelectionChange(currentScope, parsed.data)) {
        const connection = await getJiraConnection(tx, ctx.workspaceId, parsed.data.connectionId);
        if (!connection) {
          return { kind: 'missing-connection' as const };
        }
        if (prefetchedBoardName === null) {
          return { kind: 'stale-board-selection' as const };
        }
        boardName = prefetchedBoardName;
      }

      const boardSelectionChangedCurrent = hasBoardSelectionChange(currentScope, parsed.data);
      const issueTypeSelectionChangedCurrent = hasIssueTypeSelectionChange(currentScope, parsed.data);

      let resolvedIncludedIssueTypeNames = currentIncludedIssueTypeNames;
      if (boardSelectionChangedCurrent || issueTypeSelectionChangedCurrent) {
        if (
          !boardSelectionChangedCurrent &&
          hasNamesForAllIds(parsed.data.includedIssueTypeIds, currentIncludedIssueTypes)
        ) {
          resolvedIncludedIssueTypeNames = selectNamedValues(
            parsed.data.includedIssueTypeIds,
            currentIncludedIssueTypes ?? [],
          ).map((issueType) => issueType.name);
        } else if (prefetchedIssueTypes.length > 0) {
          resolvedIncludedIssueTypeNames = selectNamedValues(
            parsed.data.includedIssueTypeIds,
            prefetchedIssueTypes,
          ).map((issueType) => issueType.name);
        } else {
          return { kind: 'stale-board-selection' as const };
        }
      }

      const updatedScopeInput = {
        connectionId: parsed.data.connectionId,
        boardId: parsed.data.boardId,
        boardName,
        timezone: parsed.data.timezone,
        includedIssueTypeIds: parsed.data.includedIssueTypeIds,
        includedIssueTypeNames: resolvedIncludedIssueTypeNames,
        startStatusIds: parsed.data.startStatusIds,
        doneStatusIds: parsed.data.doneStatusIds,
        syncIntervalMinutes: parsed.data.syncIntervalMinutes,
      };

      let updated;
      try {
        updated = await updateFlowScope(tx, ctx.workspaceId, scopeId, updatedScopeInput);
      } catch (err) {
        if (err instanceof Error && err.message.includes('disjoint')) {
          return { kind: 'invalid' as const, message: err.message };
        }
        throw err;
      }

      if (!updated) {
        return { kind: 'missing' as const };
      }

      if (!stillRequiresSync) {
        return { kind: 'updated' as const, updated };
      }

      const syncRun = await createSyncRun(tx, {
        scopeId,
        trigger: 'manual',
        requestedBy: ctx.userId,
      });

      return { kind: 'queued' as const, updated, syncRunId: syncRun.id, rollbackScopeInput };
    });

    if (txResult.kind === 'active') {
      return syncInProgressResponse(txResult.activeRunId);
    }
    if (txResult.kind === 'missing-connection') {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Jira connection not found.' },
        { status: 404 },
      );
    }
    if (txResult.kind === 'stale-board-selection') {
      return Response.json(
        {
          code: 'CONFLICT',
          message: 'The flow scope changed while validating the target board. Retry the update.',
        },
        { status: 409 },
      );
    }
    if (txResult.kind === 'invalid') {
      return Response.json(
        { code: 'INVALID_REQUEST', message: txResult.message },
        { status: 400 },
      );
    }
    if (txResult.kind === 'missing') {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Flow scope not found.' },
        { status: 404 },
      );
    }

    if (txResult.kind === 'queued') {
      let enqueueFailedMessage: string | null = null;
      try {
        const jobId = await enqueueScopeSyncJob({
          scopeId,
          syncRunId: txResult.syncRunId,
          requestedBy: ctx.userId,
          trigger: 'manual',
        });
        if (!jobId) {
          enqueueFailedMessage = 'pg-boss did not enqueue the follow-up sync job.';
        }
      } catch (enqueueErr) {
        enqueueFailedMessage =
          enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr);
      }

      if (enqueueFailedMessage !== null) {
        const rollback = await prisma.$transaction(async (tx) => {
          await acquireScopeSyncLock(tx, scopeId);
          await updateSyncRun(tx, txResult.syncRunId, {
            status: 'canceled',
            finishedAt: new Date(),
            errorCode: 'SYNC_ENQUEUE_FAILED',
            errorSummary: enqueueFailedMessage.slice(0, 500),
          });

          const currentScope = await getFlowScope(tx, ctx.workspaceId, scopeId);
          if (!currentScope) {
            return false;
          }

          const scopeStillMatchesUpdatedBoundary = matchesQueuedScopeForRollback(
            currentScope,
            txResult.updated,
          );

          if (!scopeStillMatchesUpdatedBoundary) {
            return false;
          }

          await updateFlowScope(tx, ctx.workspaceId, scopeId, {
            ...txResult.rollbackScopeInput,
            syncIntervalMinutes: currentScope.syncIntervalMinutes,
          });
          return true;
        });

        logger.error('Failed to enqueue follow-up sync after scope update', {
          scopeId,
          syncRunId: txResult.syncRunId,
          rollbackSucceeded: rollback,
          error: enqueueFailedMessage,
        });

        return Response.json(
          {
            code: 'SYNC_ENQUEUE_FAILED',
            message: rollback
              ? 'Failed to queue the follow-up sync, so the scope update was rolled back.'
              : 'Failed to queue the follow-up sync. The scope may need manual review.',
          },
          { status: 503 },
        );
      }
    }

    return Response.json(mapScope(txResult.updated));
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to update flow scope', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireAdminContext();
    assertTrustedMutationRequest(req);
    enforceRateLimit(req, {
      bucket: 'admin-scopes:delete',
      identifier: `${ctx.workspaceId}:${ctx.userId}:${(await params).scopeId}`,
      max: 10,
      windowMs: 5 * 60_000,
    });

    const { scopeId } = await params;
    const prisma = getPrismaClient();
    const txResult = await prisma.$transaction(async (tx) => {
      await acquireScopeSyncLock(tx, scopeId);

      const currentScope = await getFlowScope(tx, ctx.workspaceId, scopeId);
      if (!currentScope) {
        return { kind: 'missing' as const };
      }

      const activeRun = await resolveActiveSyncRun(tx, ctx.workspaceId, scopeId);
      if (activeRun) {
        return { kind: 'active' as const, activeRunId: activeRun.id };
      }

      const deleted = await deleteFlowScope(tx, ctx.workspaceId, scopeId);
      return deleted ? { kind: 'deleted' as const } : { kind: 'missing' as const };
    });

    if (txResult.kind === 'active') {
      return Response.json(
        {
          code: 'SYNC_IN_PROGRESS',
          message: 'Wait for the active sync to finish before deleting this flow scope.',
          syncRunId: txResult.activeRunId,
        },
        { status: 409 },
      );
    }

    if (txResult.kind === 'missing') {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Flow scope not found.' },
        { status: 404 },
      );
    }

    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to delete flow scope', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const PUT = withHttpMetrics('PUT', '/api/v1/admin/scopes/[scopeId]', handlePUT);
export const DELETE = withHttpMetrics('DELETE', '/api/v1/admin/scopes/[scopeId]', handleDELETE);
