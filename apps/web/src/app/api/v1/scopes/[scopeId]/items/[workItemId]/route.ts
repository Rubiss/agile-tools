import { type NextRequest } from 'next/server';
import { differenceInWorkingDays, logger } from '@agile-tools/shared';
import {
  getPrismaClient,
  getFlowScope,
  getWorkItemWithDetail,
} from '@agile-tools/db';
import type {
  WorkItemDetail,
  HoldPeriodResponse,
  LifecycleEventResponse,
} from '@agile-tools/shared/contracts/api';
import { requireWorkspaceContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { withHttpMetrics } from '@/server/route-metrics';

async function handleGET(
  _req: NextRequest,
  { params }: { params: Promise<{ scopeId: string; workItemId: string }> },
): Promise<Response> {
  try {
    const ctx = await requireWorkspaceContext();
    const { scopeId, workItemId } = await params;
    const db = getPrismaClient();

    // Verify the scope belongs to this workspace before exposing work item data.
    const scope = await getFlowScope(db, ctx.workspaceId, scopeId);
    if (!scope) {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Flow scope not found.' },
        { status: 404 },
      );
    }

    const item = await getWorkItemWithDetail(db, scopeId, workItemId);
    if (!item) {
      return Response.json(
        { code: 'NOT_FOUND', message: 'Work item not found.' },
        { status: 404 },
      );
    }

    const now = new Date();
    const referenceDate = item.startedAt ?? item.createdAt;
    const endDate = item.completedAt ?? now;
    const ageDays = differenceInWorkingDays(referenceDate, endDate, scope.timezone);

    const holdPeriods: HoldPeriodResponse[] = item.holdPeriods.map((hp) => ({
      startedAt: hp.startedAt.toISOString(),
      ...(hp.endedAt ? { endedAt: hp.endedAt.toISOString() } : {}),
      source: hp.source,
      ...(hp.sourceValue ? { sourceValue: hp.sourceValue } : {}),
    }));

    const lifecycleEvents: LifecycleEventResponse[] = item.lifecycleEvents.map((ev) => ({
      eventType: ev.eventType,
      ...(ev.fromStatusId ? { fromStatus: ev.fromStatusId } : {}),
      ...(ev.toStatusId ? { toStatus: ev.toStatusId } : {}),
      changedAt: ev.changedAt.toISOString(),
    }));

    return Response.json({
      workItemId: item.id,
      issueKey: item.issueKey,
      summary: item.summary,
      currentStatus: item.currentStatusName ?? item.currentColumn ?? item.currentStatusId,
      ...(item.assigneeName ? { assigneeName: item.assigneeName } : {}),
      ageDays,
      jiraUrl: item.directUrl,
      ...(item.startedAt ? { startedAt: item.startedAt.toISOString() } : {}),
      ...(item.completedAt ? { completedAt: item.completedAt.toISOString() } : {}),
      holdPeriods,
      lifecycleEvents,
      warnings: [],
    } satisfies WorkItemDetail);
  } catch (err) {
    if (err instanceof ResponseError) return err.response;
    logger.error('Failed to fetch work item detail', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  }
}

export const GET = withHttpMetrics('GET', '/api/v1/scopes/[scopeId]/items/[workItemId]', handleGET);
