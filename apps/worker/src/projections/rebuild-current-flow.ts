import type { PrismaClient } from '@agile-tools/db';
import {
  buildAgingThresholdModel,
  buildColumnDurationsForItem,
  parseBoardColumnMappings,
  type AgingThresholdResult,
  type BoardColumnMapping,
} from '@agile-tools/analytics';
import { differenceInWorkingDays, logger } from '@agile-tools/shared';
import type { ColumnAgingModel } from '@agile-tools/shared/contracts/api';

export const DEFAULT_HISTORICAL_WINDOW_DAYS = 90;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Rebuild the AgingThresholdModel for a scope after a successful sync.
 *
 * Queries completed work items within the historical window, computes
 * percentile-based thresholds from their cycle times, and persists the result
 * to AgingThresholdModel so the flow analytics API can serve enriched data
 * without re-computing on every request.
 *
 * Called by rebuildScopeProjections after hold periods are rebuilt.
 */
export async function rebuildCurrentFlowProjection(
  db: PrismaClient,
  scopeId: string,
  syncRunId: string,
  options?: { historicalWindowDays?: number },
): Promise<AgingThresholdResult> {
  const windowDays = options?.historicalWindowDays ?? DEFAULT_HISTORICAL_WINDOW_DAYS;
  const windowStart = new Date(Date.now() - windowDays * MS_PER_DAY);
  const scope = await db.flowScope.findUnique({
    where: { id: scopeId },
    select: { timezone: true },
  });

  if (!scope) {
    throw new Error(`Flow scope ${scopeId} not found while rebuilding current flow projection.`);
  }

  const [snapshot, completedItems] = await Promise.all([
    db.boardSnapshot.findFirst({
      where: { scopeId, syncRunId },
      orderBy: { fetchedAt: 'desc' },
      select: { columns: true },
    }),
    db.workItem.findMany({
      where: {
        scopeId,
        completedAt: { not: null, gte: windowStart },
        excludedReason: null,
        lastSyncRunId: syncRunId,
      },
      select: {
        startedAt: true,
        completedAt: true,
        createdAt: true,
        currentStatusId: true,
        holdPeriods: {
          select: { startedAt: true, endedAt: true },
        },
        lifecycleEvents: {
          where: { eventType: 'status_change' },
          select: {
            fromStatusId: true,
            toStatusId: true,
            changedAt: true,
          },
          orderBy: { changedAt: 'asc' },
        },
      },
    }),
  ]);

  const completedStories = completedItems.map((item) => {
    const referenceDate = item.startedAt ?? item.createdAt;
    return {
      cycleTimeDays: differenceInWorkingDays(referenceDate, item.completedAt!, scope.timezone),
    };
  });
  const columns = parseBoardColumnMappings(snapshot?.columns);
  const columnThresholds = buildColumnAgingModels({
    completedItems,
    columns,
    timezone: scope.timezone,
    windowDays,
  });

  const result = buildAgingThresholdModel(completedStories, windowDays);

  await db.agingThresholdModel.create({
    data: {
      scopeId,
      historicalWindowDays: windowDays,
      sampleSize: result.sampleSize,
      p50: result.p50,
      p70: result.p70,
      p85: result.p85,
      columnThresholds,
      calculatedAt: new Date(),
      dataVersion: syncRunId,
      ...(result.lowConfidenceReason !== null && {
        lowConfidenceReason: result.lowConfidenceReason,
      }),
    },
  });

  logger.info('Aging threshold model rebuilt', {
    scopeId,
    syncRunId,
    sampleSize: result.sampleSize,
    p50: result.p50,
    p70: result.p70,
    p85: result.p85,
    columnThresholdCount: columnThresholds.length,
    lowConfidenceReason: result.lowConfidenceReason ?? null,
  });

  return result;
}

function buildColumnAgingModels({
  completedItems,
  columns,
  timezone,
  windowDays,
}: {
  completedItems: Array<{
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    currentStatusId: string;
    lifecycleEvents: Array<{ fromStatusId: string | null; toStatusId: string | null; changedAt: Date }>;
    holdPeriods: Array<{ startedAt: Date; endedAt: Date | null }>;
  }>;
  columns: BoardColumnMapping[];
  timezone: string;
  windowDays: number;
}): ColumnAgingModel[] {
  const samplesByColumn = new Map<string, { column: BoardColumnMapping; samples: number[] }>();
  for (const column of columns) {
    samplesByColumn.set(column.name, { column, samples: [] });
  }

  for (const item of completedItems) {
    if (!item.completedAt) continue;
    const { columnDurations } = buildColumnDurationsForItem({
      createdAt: item.createdAt,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      currentStatusId: item.currentStatusId,
      statusChanges: item.lifecycleEvents,
      holdIntervals: item.holdPeriods,
      columns,
      now: item.completedAt,
      timezone,
    });

    for (const duration of columnDurations) {
      let bucket = samplesByColumn.get(duration.columnName);
      if (!bucket) {
        bucket = {
          column: { name: duration.columnName, statusIds: duration.statusIds },
          samples: [],
        };
        samplesByColumn.set(duration.columnName, bucket);
      }
      if (duration.workingDays <= 0) continue;
      bucket.samples.push(duration.workingDays);
    }
  }

  return Array.from(samplesByColumn.values()).map(({ column, samples }) => {
    const model = buildAgingThresholdModel(
      samples.map((cycleTimeDays) => ({ cycleTimeDays })),
      windowDays,
    );

    return {
      columnName: column.name,
      statusIds: column.statusIds,
      metricBasis: 'column_working_days',
      p50: model.p50,
      p70: model.p70,
      p85: model.p85,
      sampleSize: model.sampleSize,
      ...(model.lowConfidenceReason ? { lowConfidenceReason: model.lowConfidenceReason } : {}),
    };
  });
}
