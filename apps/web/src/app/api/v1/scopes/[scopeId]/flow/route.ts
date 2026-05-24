import { type NextRequest } from 'next/server';
import { logger, metricsClock, recordFlowRead } from '@agile-tools/shared';
import {
  getPrismaClient,
  getFlowScope,
  getLastSucceededSyncRun,
  queryCurrentWorkItems,
  getLatestAgingThresholds,
  getLatestAgingThresholdModel,
} from '@agile-tools/db';
import type { FlowAnalyticsResponse, AgingModel, FlowPoint, Warning } from '@agile-tools/shared/contracts/api';
import { requireWorkspaceContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { withHttpMetrics } from '@/server/route-metrics';

const DEFAULT_HISTORICAL_WINDOW = 90;
const LOW_CONFIDENCE_SAMPLE = 30;

async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ scopeId: string }> },
): Promise<Response> {
  const metricStartedAt = metricsClock.now();
  let metricResult = 'error';
  let metricItemCount: number | undefined;

  try {
    const ctx = await requireWorkspaceContext();
    const { scopeId } = await params;
    const db = getPrismaClient();

    // Verify the scope belongs to this workspace.
    const scope = await getFlowScope(db, ctx.workspaceId, scopeId);
    if (!scope) {
      metricResult = 'not_found';
      return Response.json(
        { code: 'NOT_FOUND', message: 'Flow scope not found.' },
        { status: 404 },
      );
    }

    // Parse query parameters.
    const url = new URL(req.url);
    const issueTypeIds = url.searchParams.getAll('issueTypeIds');
    const statusIds = url.searchParams.getAll('statusIds');
    const rawWindow = parseInt(
      url.searchParams.get('historicalWindowDays') ?? String(DEFAULT_HISTORICAL_WINDOW),
      10,
    );
    const historicalWindowDays =
      isNaN(rawWindow) || rawWindow < 30 || rawWindow > 730 ? DEFAULT_HISTORICAL_WINDOW : rawWindow;
    const agingOnly = url.searchParams.get('agingOnly') === 'true';
    const onHoldOnly = url.searchParams.get('onHoldOnly') === 'true';
    const requestedDataVersion = url.searchParams.get('dataVersion') ?? undefined;

    // Resolve the data snapshot.
    const lastSucceeded = await getLastSucceededSyncRun(db, ctx.workspaceId, scopeId);
    const effectiveDataVersion = requestedDataVersion ?? lastSucceeded?.dataVersion ?? undefined;
    const syncedAt = lastSucceeded?.finishedAt;

    if (!effectiveDataVersion || !syncedAt) {
      metricResult = 'no_data';
      metricItemCount = 0;
      return Response.json({
        scopeId,
        dataVersion: '',
        syncedAt: new Date(0).toISOString(),
        historicalWindowDays,
        sampleSize: 0,
        warnings: [{ code: 'NO_DATA', message: 'No synchronized data available yet.' }] satisfies Warning[],
        agingModel: {
          metricBasis: 'cycle_time',
          p50: 0,
          p70: 0,
          p85: 0,
          sampleSize: 0,
          lowConfidenceReason: 'No completed stories in history.',
        } satisfies AgingModel,
        points: [] satisfies FlowPoint[],
      } satisfies FlowAnalyticsResponse);
    }

    // Load aging thresholds for work item zone classification, and the full model for the response.
    const [agingThresholds, agingModelRow] = await Promise.all([
      getLatestAgingThresholds(db, scopeId, { dataVersion: effectiveDataVersion }),
      getLatestAgingThresholdModel(db, scopeId, { dataVersion: effectiveDataVersion }),
    ]);

    // Query active work items for this scope.
    const items = await queryCurrentWorkItems(db, scopeId, {
      dataVersion: effectiveDataVersion,
      timezone: scope.timezone,
      ...(agingThresholds ? { agingThresholds } : {}),
    });

    // Apply optional filters.
    let filtered = items;
    if (issueTypeIds.length > 0) {
      filtered = filtered.filter((i) => issueTypeIds.includes(i.issueTypeId));
    }
    if (statusIds.length > 0) {
      filtered = filtered.filter((i) => statusIds.includes(i.currentStatusId));
    }
    if (agingOnly) {
      filtered = filtered.filter((i) => i.agingZone !== 'normal');
    }
    if (onHoldOnly) {
      filtered = filtered.filter((i) => i.onHoldNow);
    }

    const agingModel: AgingModel = agingModelRow
      ? {
          metricBasis: 'cycle_time',
          p50: agingModelRow.p50,
          p70: agingModelRow.p70,
          p85: agingModelRow.p85,
          sampleSize: agingModelRow.sampleSize,
          ...(agingModelRow.lowConfidenceReason
            ? { lowConfidenceReason: agingModelRow.lowConfidenceReason }
            : {}),
        }
      : {
          metricBasis: 'cycle_time',
          p50: 0,
          p70: 0,
          p85: 0,
          sampleSize: 0,
          lowConfidenceReason: 'No completed stories in history.',
        };

    const warnings: Warning[] = [];
    if (agingModel.sampleSize < LOW_CONFIDENCE_SAMPLE) {
      warnings.push({
        code: 'LOW_AGING_CONFIDENCE',
        message: `Aging thresholds are based on only ${agingModel.sampleSize} completed stories; results may be unreliable until at least ${LOW_CONFIDENCE_SAMPLE} stories are completed.`,
      });
    }

    const points: FlowPoint[] = filtered.map((item) => ({
      workItemId: item.workItemId,
      issueKey: item.issueKey,
      summary: item.summary,
      issueType: item.issueTypeName,
      currentStatus: item.currentStatusName,
      currentColumn: item.currentColumn,
      ...(item.assigneeName ? { assigneeName: item.assigneeName } : {}),
      ageDays: item.ageInDays,
      totalHoldHours: item.totalHoldHours,
      onHoldNow: item.onHoldNow,
      agingZone: item.agingZone,
      jiraUrl: item.directUrl,
    }));
    metricResult = 'success';
    metricItemCount = points.length;

    return Response.json({
      scopeId,
      dataVersion: effectiveDataVersion,
      syncedAt: syncedAt.toISOString(),
      historicalWindowDays,
      sampleSize: filtered.length,
      warnings,
      agingModel,
      points,
    } satisfies FlowAnalyticsResponse);
  } catch (err) {
    if (err instanceof ResponseError) {
      metricResult = 'response_error';
      return err.response;
    }
    logger.error('Failed to fetch flow analytics', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' },
      { status: 500 },
    );
  } finally {
    recordFlowRead({
      result: metricResult,
      durationSeconds: metricsClock.durationSecondsSince(metricStartedAt),
      ...(metricItemCount !== undefined ? { itemCount: metricItemCount } : {}),
    });
  }
}

export const GET = withHttpMetrics('GET', '/api/v1/scopes/[scopeId]/flow', handleGET);
