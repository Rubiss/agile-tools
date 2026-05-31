import type { PrismaClient } from '@prisma/client';
import {
  buildColumnDurationsForItem,
  type BoardColumnMapping,
  type ColumnDurationResult,
} from '@agile-tools/analytics';
import { differenceInWorkingDays } from '@agile-tools/shared';

/**
 * Percentile thresholds used to classify a work item's aging zone.
 * Sourced from the latest AgingThresholdModel for the scope.
 */
export interface AgingThresholds {
  p50: number;
  p85: number;
}

export interface CurrentWorkItemRow {
  workItemId: string;
  scopeId: string;
  issueKey: string;
  summary: string;
  issueTypeId: string;
  /** Human-readable issue type name; falls back to issueTypeId when not available. */
  issueTypeName: string;
  currentStatusId: string;
  /** Human-readable Jira status name; falls back to currentStatusId when not available. */
  currentStatusName: string;
  /** Board column name; falls back to currentStatusId when the status has no column mapping. */
  currentColumn: string;
  /** Human-readable assignee display value; null when the issue is unassigned. */
  assigneeName: string | null;
  /** Working age in fractional days from startedAt (or createdAt if not yet started). */
  ageInDays: number;
  /** Working days spent in the current contiguous board-column visit. */
  currentColumnAgeDays?: number;
  /** Per-column working-day durations, summed across repeated visits. */
  columnDurations?: ColumnDurationResult[];
  startedAt: Date | null;
  /** Total hold duration in hours derived from HoldPeriod records. */
  totalHoldHours: number;
  /** True when the item has an open HoldPeriod (endedAt IS NULL). */
  onHoldNow: boolean;
  /**
   * Aging zone classification.
   * Defaults to 'normal' until AgingThresholdModel is computed (US2).
   */
  agingZone: 'normal' | 'watch' | 'aging';
  directUrl: string;
}

export interface ScopeFilterOptions {
  /** Distinct issue types present in the latest-synced active work items. */
  issueTypes: Array<{ id: string; name: string }>;
  /**
   * Distinct statuses present in the latest-synced active work items.
   * id = Jira status ID (for server-side filtering);
   * name = board column name for display (falls back to status ID).
   */
  statuses: Array<{ id: string; name: string }>;
}

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * Query in-flow (started, non-completed, non-excluded) work items for a scope
 * with computed projection fields.
 *
 * Only items that have transitioned into a startStatusId at some point (i.e.,
 * have a non-null `startedAt`) are returned. Items still in pre-start statuses
 * (e.g., Backlog / Triage / To Do that are not configured as a start status)
 * are excluded so the flow analytics chart matches the scope boundaries used
 * by aging-threshold and forecast calculations.
 *
 * Pass `dataVersion` (= the latest succeeded SyncRun id) to pin results to a
 * specific sync snapshot and exclude stale items that disappeared from the board.
 */
export async function queryCurrentWorkItems(
  db: PrismaClient,
  scopeId: string,
  options?: {
    dataVersion?: string;
    agingThresholds?: AgingThresholds;
    timezone?: string;
    columnMappings?: BoardColumnMapping[];
    now?: Date;
  },
): Promise<CurrentWorkItemRow[]> {
  const now = options?.now ?? new Date();
  const timezone = options?.timezone ?? 'UTC';

  const items = await db.workItem.findMany({
    where: {
      scopeId,
      completedAt: null,
      startedAt: { not: null },
      excludedReason: null,
      ...(options?.dataVersion ? { lastSyncRunId: options.dataVersion } : {}),
    },
    select: {
      id: true,
      scopeId: true,
      issueKey: true,
      summary: true,
      issueTypeId: true,
      issueTypeName: true,
      currentStatusId: true,
      currentStatusName: true,
      currentColumn: true,
      assigneeName: true,
      startedAt: true,
      createdAt: true,
      directUrl: true,
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
    orderBy: { startedAt: 'asc' },
  });

  return items.map((item) => {
    const referenceDate = item.startedAt ?? item.createdAt;
    const ageInDays = differenceInWorkingDays(referenceDate, now, timezone);

    let totalHoldMs = 0;
    let onHoldNow = false;

    for (const hp of item.holdPeriods) {
      const end = hp.endedAt ?? now;
      totalHoldMs += end.getTime() - hp.startedAt.getTime();
      if (!hp.endedAt) {
        onHoldNow = true;
      }
    }

    const totalHoldHours = totalHoldMs / MS_PER_HOUR;

    const columnDurationResult = options?.columnMappings
      ? buildColumnDurationsForItem({
          createdAt: item.createdAt,
          startedAt: item.startedAt,
          completedAt: null,
          currentStatusId: item.currentStatusId,
          statusChanges: item.lifecycleEvents,
          holdIntervals: item.holdPeriods,
          columns: options.columnMappings,
          now,
          timezone,
        })
      : null;

    return {
      workItemId: item.id,
      scopeId: item.scopeId,
      issueKey: item.issueKey,
      summary: item.summary,
      issueTypeId: item.issueTypeId,
      issueTypeName: item.issueTypeName ?? item.issueTypeId,
      currentStatusId: item.currentStatusId,
      currentStatusName: item.currentStatusName ?? item.currentColumn ?? item.currentStatusId,
      currentColumn: item.currentColumn ?? item.currentStatusName ?? item.currentStatusId,
      assigneeName: item.assigneeName,
      ageInDays,
      ...(columnDurationResult?.currentColumnDwell
        ? { currentColumnAgeDays: columnDurationResult.currentColumnDwell.workingDays }
        : {}),
      ...(columnDurationResult ? { columnDurations: columnDurationResult.columnDurations } : {}),
      startedAt: item.startedAt,
      totalHoldHours,
      onHoldNow,
      agingZone: options?.agingThresholds
        ? classifyAgingZone(ageInDays, options.agingThresholds)
        : ('normal' as const),
      directUrl: item.directUrl,
    };
  });
}

/**
 * Derive distinct filter options from in-flow work items for a scope.
 *
 * Mirrors the filter applied by `queryCurrentWorkItems` (started, non-completed,
 * non-excluded) so the status dropdown does not surface pre-start statuses that
 * would yield zero dots on the flow analytics chart.
 *
 * Pass `dataVersion` to pin to a specific sync snapshot (same semantics as
 * `queryCurrentWorkItems`).
 */
export async function queryScopeFilterOptions(
  db: PrismaClient,
  scopeId: string,
  options?: { dataVersion?: string },
): Promise<ScopeFilterOptions> {
  const items = await db.workItem.findMany({
    where: {
      scopeId,
      completedAt: null,
      startedAt: { not: null },
      excludedReason: null,
      ...(options?.dataVersion ? { lastSyncRunId: options.dataVersion } : {}),
    },
    select: {
      issueTypeId: true,
      issueTypeName: true,
      currentStatusId: true,
      currentStatusName: true,
      currentColumn: true,
    },
  });

  const issueTypeMap = new Map<string, string>();
  const statusMap = new Map<string, string>();

  for (const item of items) {
    if (!issueTypeMap.has(item.issueTypeId)) {
      issueTypeMap.set(item.issueTypeId, item.issueTypeName ?? item.issueTypeId);
    }
    if (!statusMap.has(item.currentStatusId)) {
      statusMap.set(
        item.currentStatusId,
        item.currentColumn ?? item.currentStatusName ?? item.currentStatusId,
      );
    }
  }

  return {
    issueTypes: Array.from(issueTypeMap.entries()).map(([id, name]) => ({ id, name })),
    statuses: Array.from(statusMap.entries()).map(([id, name]) => ({ id, name })),
  };
}

/**
 * Retrieve the most recently computed aging thresholds for a scope.
 *
 * Pass `dataVersion` (= syncRunId) to pin to a specific model version.
 * Returns null when no AgingThresholdModel exists for the scope yet.
 */
export async function getLatestAgingThresholds(
  db: PrismaClient,
  scopeId: string,
  options?: { dataVersion?: string },
): Promise<AgingThresholds | null> {
  const model = await db.agingThresholdModel.findFirst({
    where: {
      scopeId,
      ...(options?.dataVersion ? { dataVersion: options.dataVersion } : {}),
    },
    orderBy: { calculatedAt: 'desc' },
  });

  if (!model) return null;
  return { p50: model.p50, p85: model.p85 };
}

/**
 * Retrieve the full AgingThresholdModel record for a scope, including p70,
 * sampleSize, metricBasis, and lowConfidenceReason needed by the flow API.
 *
 * Pass `dataVersion` to pin to a specific model version.
 * Returns null when no model has been computed yet.
 */
export async function getLatestAgingThresholdModel(
  db: PrismaClient,
  scopeId: string,
  options?: { dataVersion?: string },
): Promise<{
  p50: number;
  p70: number;
  p85: number;
  sampleSize: number;
  metricBasis: string;
  lowConfidenceReason: string | null;
  columnThresholds: unknown;
} | null> {
  const model = await db.agingThresholdModel.findFirst({
    where: {
      scopeId,
      ...(options?.dataVersion ? { dataVersion: options.dataVersion } : {}),
    },
    orderBy: { calculatedAt: 'desc' },
  });
  if (!model) return null;
  return {
    p50: model.p50,
    p70: model.p70,
    p85: model.p85,
    sampleSize: model.sampleSize,
    metricBasis: model.metricBasis,
    lowConfidenceReason: model.lowConfidenceReason,
    columnThresholds: model.columnThresholds,
  };
}

export async function getBoardColumnMappingsForDataVersion(
  db: PrismaClient,
  scopeId: string,
  dataVersion: string,
): Promise<BoardColumnMapping[]> {
  const snapshot = await db.boardSnapshot.findFirst({
    where: { scopeId, syncRunId: dataVersion },
    orderBy: { fetchedAt: 'desc' },
    select: { columns: true },
  });

  return parseBoardColumnMappings(snapshot?.columns);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Classify a work item's age against pre-computed percentile thresholds.
 *
 * - 'normal' when ageDays <= p50
 * - 'watch'  when p50 < ageDays <= p85
 * - 'aging'  when ageDays > p85
 *
 * Falls back to 'normal' when thresholds are zero (no data yet).
 */
function classifyAgingZone(
  ageDays: number,
  thresholds: AgingThresholds,
): 'normal' | 'watch' | 'aging' {
  if (thresholds.p85 <= 0 && thresholds.p50 <= 0) return 'normal';
  if (ageDays > thresholds.p85) return 'aging';
  if (ageDays > thresholds.p50) return 'watch';
  return 'normal';
}

function parseBoardColumnMappings(value: unknown): BoardColumnMapping[] {
  if (!Array.isArray(value)) return [];
  const columns: BoardColumnMapping[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { name?: unknown; statusIds?: unknown };
    if (typeof candidate.name !== 'string' || !Array.isArray(candidate.statusIds)) continue;
    const statusIds = candidate.statusIds.filter((statusId): statusId is string => typeof statusId === 'string');
    columns.push({ name: candidate.name, statusIds });
  }

  return columns;
}
