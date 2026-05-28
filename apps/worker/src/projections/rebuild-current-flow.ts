import type { PrismaClient } from '@agile-tools/db';
import { buildAgingThresholdModel, type AgingThresholdResult } from '@agile-tools/analytics';
import { differenceInWorkingDays, logger } from '@agile-tools/shared';

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

  const completedItems = await db.workItem.findMany({
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
    },
  });

  const completedStories = completedItems.map((item) => {
    const referenceDate = item.startedAt ?? item.createdAt;
    return {
      cycleTimeDays: differenceInWorkingDays(referenceDate, item.completedAt!, scope.timezone),
    };
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
    lowConfidenceReason: result.lowConfidenceReason ?? null,
  });

  return result;
}
