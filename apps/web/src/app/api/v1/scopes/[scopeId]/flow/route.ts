import { type NextRequest } from 'next/server';
import { logger, metricsClock, recordFlowRead } from '@agile-tools/shared';
import {
  getPrismaClient,
  getFlowScope,
  getLastSucceededSyncRun,
  queryCurrentWorkItems,
  getLatestAgingThresholds,
  getLatestAgingThresholdModel,
  getBoardColumnMappingsForDataVersion,
} from '@agile-tools/db';
import {
  ColumnAgingModelSchema,
  type FlowAnalyticsResponse,
  type AgingModel,
  type AgingZone,
  type ColumnAgingModel,
  type ColumnDuration,
  type FlowPoint,
  type Warning,
} from '@agile-tools/shared/contracts/api';
import { requireWorkspaceContext } from '@/server/auth';
import { ResponseError } from '@/server/errors';
import { withHttpMetrics } from '@/server/route-metrics';
import { selectInScopeColumnAgingModels } from './column-aging-scope';

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
        columnAgingModels: [] satisfies ColumnAgingModel[],
        points: [] satisfies FlowPoint[],
      } satisfies FlowAnalyticsResponse);
    }

    // Load aging thresholds for work item zone classification, and the full model for the response.
    const [agingThresholds, agingModelRow, columnMappings] = await Promise.all([
      getLatestAgingThresholds(db, scopeId, { dataVersion: effectiveDataVersion }),
      getLatestAgingThresholdModel(db, scopeId, { dataVersion: effectiveDataVersion }),
      getBoardColumnMappingsForDataVersion(db, scopeId, effectiveDataVersion),
    ]);

    // Query active work items for this scope.
    const items = await queryCurrentWorkItems(db, scopeId, {
      dataVersion: effectiveDataVersion,
      timezone: scope.timezone,
      ...(agingThresholds ? { agingThresholds } : {}),
      ...(columnMappings.length > 0 ? { columnMappings } : {}),
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

    const columnAgingModels = selectInScopeColumnAgingModels(
      parseColumnAgingModels(agingModelRow?.columnThresholds),
      columnMappings,
      scope.startStatusIds,
      scope.doneStatusIds,
    );
    const columnAgingModelByName = new Map(columnAgingModels.map((model) => [model.columnName, model]));

    const points: FlowPoint[] = filtered.map((item) => ({
      workItemId: item.workItemId,
      issueKey: item.issueKey,
      summary: item.summary,
      issueType: item.issueTypeName,
      currentStatus: item.currentStatusName,
      currentColumn: item.currentColumn,
      ...(item.assigneeName ? { assigneeName: item.assigneeName } : {}),
      ageDays: item.ageInDays,
      ...(item.currentColumnAgeDays !== undefined ? { currentColumnAgeDays: item.currentColumnAgeDays } : {}),
      ...(item.currentColumnAgeDays !== undefined
        ? {
            currentColumnAgingZone: classifyColumnAgingZone(
              item.currentColumnAgeDays,
              columnAgingModelByName.get(item.currentColumn),
            ),
          }
        : {}),
      ...(item.columnDurations ? { columnDurations: item.columnDurations.map(toColumnDurationResponse) } : {}),
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
      columnAgingModels,
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

function parseColumnAgingModels(value: unknown): ColumnAgingModel[] {
  const parsed = ColumnAgingModelSchema.array().safeParse(value ?? []);
  if (!parsed.success) return [];
  return parsed.data;
}

function classifyColumnAgingZone(ageDays: number, model: ColumnAgingModel | undefined): AgingZone {
  if (!model || (model.p85 <= 0 && model.p50 <= 0)) return 'normal';
  if (ageDays > model.p85) return 'aging';
  if (ageDays > model.p50) return 'watch';
  return 'normal';
}

function toColumnDurationResponse(duration: {
  columnName: string;
  statusIds: string[];
  workingDays: number;
  holdWorkingDays: number;
  visitCount: number;
  current: boolean;
  firstEnteredAt: Date | null;
  lastEnteredAt: Date | null;
}): ColumnDuration {
  return {
    columnName: duration.columnName,
    statusIds: duration.statusIds,
    workingDays: duration.workingDays,
    holdWorkingDays: duration.holdWorkingDays,
    visitCount: duration.visitCount,
    current: duration.current,
    ...(duration.firstEnteredAt ? { firstEnteredAt: duration.firstEnteredAt.toISOString() } : {}),
    ...(duration.lastEnteredAt ? { lastEnteredAt: duration.lastEnteredAt.toISOString() } : {}),
  };
}
