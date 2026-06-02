import type { ColumnAgingModel, ColumnDuration, FlowAnalyticsResponse, AgingModel } from '@agile-tools/shared/contracts/api';

/** A single datum on the aging scatter plot. */
export interface ScatterDatum {
  x: number; // ageDays — the X axis value
  y: number; // stable ordinal index (0-based, sorted by ageDays descending)
  workItemId: string;
  issueKey: string;
  summary: string;
  issueType?: string;
  currentStatus: string;
  currentColumn?: string;
  assigneeName?: string;
  onHoldNow: boolean;
  agingZone: 'normal' | 'watch' | 'aging';
  jiraUrl?: string;
}

/** A single datum on the per-column dwell scatter plot. */
export interface ColumnScatterDatum {
  x: number; // stable ordinal index for the current board column
  y: number; // current-column dwell in working days
  workItemId: string;
  issueKey: string;
  summary: string;
  issueType?: string;
  currentStatus: string;
  currentColumn: string;
  assigneeName?: string;
  onHoldNow: boolean;
  agingZone: 'normal' | 'watch' | 'aging';
  jiraUrl?: string;
  columnDurations: ColumnDuration[];
}

/** Scatter data grouped by aging zone for per-series colour coding. */
export interface FlowAnalyticsSeries {
  id: 'normal' | 'watch' | 'aging';
  data: ScatterDatum[];
}

/** Scatter data grouped by per-column aging zone for per-series colour coding. */
export interface ColumnAnalyticsSeries {
  id: 'normal' | 'watch' | 'aging';
  data: ColumnScatterDatum[];
}

/** View model consumed by AgingScatterPlot and FlowAnalyticsSection. */
export interface FlowAnalyticsViewModel {
  series: FlowAnalyticsSeries[];
  columnSeries: ColumnAnalyticsSeries[];
  agingModel: AgingModel;
  columnAgingModels: ColumnAgingModel[];
  columnNames: string[];
  sampleSize: number;
  dataVersion: string;
  syncedAt: string;
}

/**
 * Shape a FlowAnalyticsResponse into the view model consumed by
 * AgingScatterPlot.
 *
 * Assigns stable Y ordinals by sorting points in ageDays-descending order
 * so the oldest items appear at the top of the chart.
 */
export function shapeFlowAnalytics(response: FlowAnalyticsResponse): FlowAnalyticsViewModel {
  const sorted = [...response.points].sort((a, b) => b.ageDays - a.ageDays);

  const byZone: Record<'normal' | 'watch' | 'aging', ScatterDatum[]> = {
    normal: [],
    watch: [],
    aging: [],
  };
  const columnByZone: Record<'normal' | 'watch' | 'aging', ColumnScatterDatum[]> = {
    normal: [],
    watch: [],
    aging: [],
  };
  const columnNames = buildColumnNames(response);

  sorted.forEach((point, index) => {
    const datum: ScatterDatum = {
      x: point.ageDays,
      y: index,
      workItemId: point.workItemId,
      issueKey: point.issueKey,
      summary: point.summary,
      ...(point.issueType ? { issueType: point.issueType } : {}),
      currentStatus: point.currentStatus,
      ...(point.currentColumn ? { currentColumn: point.currentColumn } : {}),
      ...(point.assigneeName ? { assigneeName: point.assigneeName } : {}),
      onHoldNow: point.onHoldNow,
      agingZone: point.agingZone,
      ...(point.jiraUrl ? { jiraUrl: point.jiraUrl } : {}),
    };
    byZone[point.agingZone].push(datum);

    if (point.currentColumn && point.currentColumnAgeDays !== undefined) {
      const columnZone = point.currentColumnAgingZone ?? point.agingZone;
      columnByZone[columnZone].push({
        x: columnNames.indexOf(point.currentColumn),
        y: point.currentColumnAgeDays,
        workItemId: point.workItemId,
        issueKey: point.issueKey,
        summary: point.summary,
        ...(point.issueType ? { issueType: point.issueType } : {}),
        currentStatus: point.currentStatus,
        currentColumn: point.currentColumn,
        ...(point.assigneeName ? { assigneeName: point.assigneeName } : {}),
        onHoldNow: point.onHoldNow,
        agingZone: columnZone,
        ...(point.jiraUrl ? { jiraUrl: point.jiraUrl } : {}),
        columnDurations: point.columnDurations ?? [],
      });
    }
  });

  return {
    series: [
      { id: 'normal', data: byZone.normal },
      { id: 'watch', data: byZone.watch },
      { id: 'aging', data: byZone.aging },
    ],
    columnSeries: [
      { id: 'normal', data: columnByZone.normal },
      { id: 'watch', data: columnByZone.watch },
      { id: 'aging', data: columnByZone.aging },
    ],
    agingModel: response.agingModel,
    columnAgingModels: response.columnAgingModels ?? [],
    columnNames,
    sampleSize: response.sampleSize,
    dataVersion: response.dataVersion,
    syncedAt: response.syncedAt,
  };
}

function buildColumnNames(response: FlowAnalyticsResponse): string[] {
  const names: string[] = [];
  for (const model of response.columnAgingModels ?? []) {
    names.push(model.columnName);
  }
  if (names.length === 0) {
    for (const point of response.points) {
      if (point.currentColumn) names.push(point.currentColumn);
    }
  }
  return Array.from(new Set(names));
}
