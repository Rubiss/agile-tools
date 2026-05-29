import type { PrismaClient } from '@prisma/client';

import {
  addLocalDateDays,
  bucketToPreviousWorkingDay,
  differenceInWorkingDays,
  formatDateInTimezone as sharedFormatDateInTimezone,
  isWeekendDate,
} from '@agile-tools/shared';

export const DEFAULT_COMPLETED_WINDOW_DAYS = 90;
export const DEFAULT_THROUGHPUT_WINDOW_DAYS = 90;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// ─── Completed stories ───────────────────────────────────────────────────────

export interface CompletedStoryRow {
  workItemId: string;
  issueKey: string;
  completedAt: Date;
  /** Cycle time in fractional working days from startedAt (or createdAt) to completedAt. */
  cycleTimeDays: number;
  /** Total on-hold duration in fractional days derived from HoldPeriod records. */
  holdTimeDays: number;
  reopenedCount: number;
}

/**
 * Query completed, non-excluded work items for a scope within a historical window.
 *
 * Returns one row per completed story with computed cycle-time and hold-time
 * metrics. This projection is used by:
 *  - The throughput API to build daily throughput charts.
 *  - The Monte Carlo engine as the source dataset for forecast sampling.
 *
 * Pass `dataVersion` (= a syncRunId) to pin results to a specific sync snapshot.
 */
export async function queryCompletedStories(
  db: PrismaClient,
  scopeId: string,
  options?: { windowDays?: number; dataVersion?: string; timezone?: string },
): Promise<CompletedStoryRow[]> {
  const windowDays = options?.windowDays ?? DEFAULT_COMPLETED_WINDOW_DAYS;
  const windowStart = new Date(Date.now() - windowDays * MS_PER_DAY);
  const timezone = options?.timezone ?? 'UTC';

  const items = await db.workItem.findMany({
    where: {
      scopeId,
      completedAt: { not: null, gte: windowStart },
      excludedReason: null,
      ...(options?.dataVersion ? { lastSyncRunId: options.dataVersion } : {}),
    },
    include: { holdPeriods: true },
    orderBy: { completedAt: 'asc' },
  });

  return items.map((item) => {
    const referenceDate = item.startedAt ?? item.createdAt;
    const cycleTimeDays = differenceInWorkingDays(referenceDate, item.completedAt!, timezone);

    let totalHoldMs = 0;
    for (const hp of item.holdPeriods) {
      const end = hp.endedAt ?? item.completedAt!;
      totalHoldMs += Math.max(0, end.getTime() - hp.startedAt.getTime());
    }
    const holdTimeDays = totalHoldMs / MS_PER_DAY;

    return {
      workItemId: item.id,
      issueKey: item.issueKey,
      completedAt: item.completedAt!,
      cycleTimeDays,
      holdTimeDays,
      reopenedCount: item.reopenedCount,
    };
  });
}

// ─── Daily throughput ────────────────────────────────────────────────────────

export interface DailyThroughputRow {
  /** Working-day date in the scope's timezone, formatted as YYYY-MM-DD. */
  day: string;
  completedStoryCount: number;
  /** True when this working day is fully in the past (not the current local weekday). */
  complete: boolean;
}

export const formatDateInTimezone = sharedFormatDateInTimezone;

/**
 * Build a daily throughput projection for a scope within a historical window.
 *
 * Returns one row per working day in the window — including working days with
 * zero completions. Zero-completion weekdays must be represented so that Monte
 * Carlo simulations sample realistic "dry day" frequency. Weekend completions
 * are re-bucketed onto the previous working day so weekend work still counts
 * toward throughput and forecast sampling.
 *
 * The `complete` flag distinguishes fully-past working days from the current
 * working-day bucket, which remains in progress. On weekends, the current
 * working-day bucket is the prior Friday because weekend completions rebucket
 * there. The Monte Carlo engine should only sample from complete working days.
 *
 * Pass `dataVersion` to pin to a specific sync snapshot.
 */
export async function queryDailyThroughput(
  db: PrismaClient,
  scopeId: string,
  timezone: string,
  options?: {
    windowDays?: number;
    dataVersion?: string;
    sampleStartDate?: string;
    sampleEndDate?: string;
    anchorDate?: Date;
  },
): Promise<DailyThroughputRow[]> {
  const windowDays = options?.windowDays ?? DEFAULT_THROUGHPUT_WINDOW_DAYS;
  const anchorDate = options?.anchorDate ?? new Date();
  const anchorLocalDate = sharedFormatDateInTimezone(anchorDate, timezone);
  const sampleStartDate = options?.sampleStartDate ?? addLocalDateDays(anchorLocalDate, -windowDays);
  const sampleEndDate = options?.sampleEndDate ?? anchorLocalDate;
  const bucketStartDate = bucketToPreviousWorkingDay(sampleStartDate);
  const queryStart = new Date(`${addLocalDateDays(sampleStartDate, -2)}T00:00:00.000Z`);
  const queryEnd = new Date(`${addLocalDateDays(sampleEndDate, 2)}T23:59:59.999Z`);

  const completedItems = await db.workItem.findMany({
    where: {
      scopeId,
      completedAt: { not: null, gte: queryStart, lte: queryEnd },
      excludedReason: null,
      ...(options?.dataVersion ? { lastSyncRunId: options.dataVersion } : {}),
    },
    select: { completedAt: true },
    orderBy: { completedAt: 'asc' },
  });

  // Bucket completions by timezone-local working day, rolling weekend
  // completions back onto the prior Friday so weekend work contributes to
  // working-day throughput without creating weekend buckets.
  const countsByDay = new Map<string, number>();
  for (const item of completedItems) {
    const completedLocalDate = sharedFormatDateInTimezone(item.completedAt!, timezone);
    if (completedLocalDate < sampleStartDate || completedLocalDate > sampleEndDate) {
      continue;
    }
    const day = bucketToPreviousWorkingDay(completedLocalDate);
    if (day < bucketStartDate || day > sampleEndDate) {
      continue;
    }
    countsByDay.set(day, (countsByDay.get(day) ?? 0) + 1);
  }

  const currentWorkingDay = bucketToPreviousWorkingDay(anchorLocalDate);

  // Generate one entry per working day from the selected local-date range.
  const days: string[] = [];
  if (bucketStartDate < sampleStartDate && countsByDay.has(bucketStartDate)) {
    days.push(bucketStartDate);
  }
  for (let day = sampleStartDate; day <= sampleEndDate; day = addLocalDateDays(day, 1)) {
    if (!isWeekendDate(day)) {
      days.push(day);
    }
  }

  return days.map((day) => ({
    day,
    completedStoryCount: countsByDay.get(day) ?? 0,
    complete: day < currentWorkingDay,
  }));
}
