import { differenceInWorkingDays } from '@agile-tools/shared';

export interface BoardColumnMapping {
  name: string;
  statusIds: string[];
}

export interface StatusChangeForColumnDuration {
  fromStatusId: string | null;
  toStatusId: string | null;
  changedAt: Date;
}

export interface HoldIntervalForColumnDuration {
  startedAt: Date;
  endedAt: Date | null;
}

export interface ColumnDurationResult {
  columnName: string;
  statusIds: string[];
  workingDays: number;
  holdWorkingDays: number;
  visitCount: number;
  current: boolean;
  firstEnteredAt: Date | null;
  lastEnteredAt: Date | null;
}

export interface CurrentColumnDwellResult {
  columnName: string;
  statusIds: string[];
  workingDays: number;
  holdWorkingDays: number;
  enteredAt: Date;
}

interface ColumnVisit {
  columnName: string;
  statusIds: string[];
  startedAt: Date;
  endedAt: Date;
}

const UNCATEGORIZED_COLUMN = 'Uncategorized';

export function buildColumnDurationsForItem({
  createdAt,
  startedAt,
  completedAt,
  currentStatusId,
  statusChanges,
  holdIntervals,
  columns,
  now,
  timezone,
}: {
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  currentStatusId: string;
  statusChanges: StatusChangeForColumnDuration[];
  holdIntervals: HoldIntervalForColumnDuration[];
  columns: BoardColumnMapping[];
  now: Date;
  timezone: string;
}): { columnDurations: ColumnDurationResult[]; currentColumnDwell: CurrentColumnDwellResult | null } {
  const start = startedAt ?? createdAt;
  const end = completedAt ?? now;
  if (end.getTime() <= start.getTime()) {
    return { columnDurations: [], currentColumnDwell: null };
  }

  const columnLookup = buildColumnLookup(columns);
  const sortedStatusChanges = statusChanges
    .filter((event) => event.changedAt.getTime() >= start.getTime() && event.changedAt.getTime() <= end.getTime())
    .sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
  const visits = collapseVisits(
    buildVisits({
      start,
      end,
      currentStatusId,
      statusChanges: sortedStatusChanges,
      columnLookup,
    }),
  );
  const mergedHolds = mergeIntervals(
    holdIntervals.map((hold) => ({
      startedAt: hold.startedAt,
      endedAt: hold.endedAt ?? now,
    })),
  );

  const byColumn = new Map<string, ColumnDurationResult>();
  for (const visit of visits) {
    const grossWorkingDays = differenceInWorkingDays(visit.startedAt, visit.endedAt, timezone);
    const holdWorkingDays = workingDaysForOverlaps(visit, mergedHolds, timezone);
    const workingDays = Math.max(0, grossWorkingDays - holdWorkingDays);
    const existing = byColumn.get(visit.columnName);

    if (existing) {
      existing.workingDays += workingDays;
      existing.holdWorkingDays += holdWorkingDays;
      existing.visitCount += 1;
      existing.lastEnteredAt = visit.startedAt;
      existing.current = existing.current || isCurrentVisit(visit, end, completedAt);
    } else {
      byColumn.set(visit.columnName, {
        columnName: visit.columnName,
        statusIds: visit.statusIds,
        workingDays,
        holdWorkingDays,
        visitCount: 1,
        current: isCurrentVisit(visit, end, completedAt),
        firstEnteredAt: visit.startedAt,
        lastEnteredAt: visit.startedAt,
      });
    }
  }

  const currentVisit = completedAt ? null : visits.find((visit) => isCurrentVisit(visit, end, completedAt)) ?? null;
  const currentColumnDwell = currentVisit
    ? {
        columnName: currentVisit.columnName,
        statusIds: currentVisit.statusIds,
        workingDays: Math.max(
          0,
          differenceInWorkingDays(currentVisit.startedAt, currentVisit.endedAt, timezone)
            - workingDaysForOverlaps(currentVisit, mergedHolds, timezone),
        ),
        holdWorkingDays: workingDaysForOverlaps(currentVisit, mergedHolds, timezone),
        enteredAt: currentVisit.startedAt,
      }
    : null;

  return {
    columnDurations: sortByBoardOrder(Array.from(byColumn.values()), columns),
    currentColumnDwell,
  };
}

function buildColumnLookup(columns: BoardColumnMapping[]): Map<string, { columnName: string; statusIds: string[] }> {
  const lookup = new Map<string, { columnName: string; statusIds: string[] }>();
  for (const column of columns) {
    for (const statusId of column.statusIds) {
      lookup.set(statusId, { columnName: column.name, statusIds: column.statusIds });
    }
  }
  return lookup;
}

function buildVisits({
  start,
  end,
  currentStatusId,
  statusChanges,
  columnLookup,
}: {
  start: Date;
  end: Date;
  currentStatusId: string;
  statusChanges: StatusChangeForColumnDuration[];
  columnLookup: Map<string, { columnName: string; statusIds: string[] }>;
}): ColumnVisit[] {
  const visits: ColumnVisit[] = [];
  let cursor = start;
  let statusId = statusChanges[0]?.fromStatusId ?? currentStatusId;

  for (const event of statusChanges) {
    if (event.changedAt.getTime() > cursor.getTime()) {
      visits.push(makeVisit(statusId, cursor, event.changedAt, columnLookup));
    }
    statusId = event.toStatusId ?? statusId;
    cursor = event.changedAt;
  }

  if (end.getTime() > cursor.getTime()) {
    visits.push(makeVisit(statusId, cursor, end, columnLookup));
  }

  return visits;
}

function makeVisit(
  statusId: string,
  startedAt: Date,
  endedAt: Date,
  columnLookup: Map<string, { columnName: string; statusIds: string[] }>,
): ColumnVisit {
  const mapped = columnLookup.get(statusId);
  return {
    columnName: mapped?.columnName ?? UNCATEGORIZED_COLUMN,
    statusIds: mapped?.statusIds ?? [statusId],
    startedAt,
    endedAt,
  };
}

function collapseVisits(visits: ColumnVisit[]): ColumnVisit[] {
  const collapsed: ColumnVisit[] = [];
  for (const visit of visits) {
    const previous = collapsed[collapsed.length - 1];
    if (previous?.columnName === visit.columnName) {
      previous.endedAt = visit.endedAt;
    } else {
      collapsed.push({ ...visit });
    }
  }
  return collapsed;
}

function mergeIntervals(intervals: Array<{ startedAt: Date; endedAt: Date }>): Array<{ startedAt: Date; endedAt: Date }> {
  const sorted = intervals
    .filter((interval) => interval.endedAt.getTime() > interval.startedAt.getTime())
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const merged: Array<{ startedAt: Date; endedAt: Date }> = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.startedAt.getTime() > previous.endedAt.getTime()) {
      merged.push({ ...interval });
      continue;
    }
    if (interval.endedAt.getTime() > previous.endedAt.getTime()) {
      previous.endedAt = interval.endedAt;
    }
  }

  return merged;
}

function workingDaysForOverlaps(
  visit: ColumnVisit,
  holds: Array<{ startedAt: Date; endedAt: Date }>,
  timezone: string,
): number {
  return holds.reduce((total, hold) => {
    const startedAt = new Date(Math.max(visit.startedAt.getTime(), hold.startedAt.getTime()));
    const endedAt = new Date(Math.min(visit.endedAt.getTime(), hold.endedAt.getTime()));
    if (endedAt.getTime() <= startedAt.getTime()) return total;
    return total + differenceInWorkingDays(startedAt, endedAt, timezone);
  }, 0);
}

function isCurrentVisit(visit: ColumnVisit, end: Date, completedAt: Date | null): boolean {
  return completedAt === null && visit.endedAt.getTime() === end.getTime();
}

function sortByBoardOrder(
  durations: ColumnDurationResult[],
  columns: BoardColumnMapping[],
): ColumnDurationResult[] {
  const order = new Map(columns.map((column, index) => [column.name, index]));
  return durations.sort((a, b) => {
    const aOrder = order.get(a.columnName) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = order.get(b.columnName) ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.columnName.localeCompare(b.columnName);
  });
}
