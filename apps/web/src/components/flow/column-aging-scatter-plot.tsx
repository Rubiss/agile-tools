'use client';

import type { ColumnScatterDatum, FlowAnalyticsViewModel } from '@/server/views/flow-analytics';
import { palette } from '@/components/app/chrome';

const zoneColors: Record<ColumnScatterDatum['agingZone'], string> = {
  normal: palette.chartPositive,
  watch: palette.chartWarning,
  aging: palette.chartDanger,
};

interface ColumnAgingScatterPlotProps {
  viewModel: FlowAnalyticsViewModel;
  onItemSelect?: (workItemId: string, issueKey: string) => void;
  height?: number;
}

export function ColumnAgingScatterPlot({
  viewModel,
  onItemSelect,
  height = 360,
}: ColumnAgingScatterPlotProps) {
  const points = viewModel.columnSeries.flatMap((serie) => serie.data);
  const columns = buildVisibleColumns(viewModel, points);

  if (points.length === 0 || columns.length === 0) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: palette.soft,
          fontSize: '0.875rem',
          border: `1px dashed ${palette.lineStrong}`,
          borderRadius: '4px',
        }}
      >
        No per-column dwell data to display.
      </div>
    );
  }

  const width = 920;
  const margin = { top: 26, right: 28, bottom: 70, left: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const columnStep = columns.length > 1 ? plotWidth / (columns.length - 1) : 0;
  const thresholdModels = viewModel.columnAgingModels.filter((model) => columns.includes(model.columnName));
  const thresholds = thresholdModels.flatMap((model) => [model.p50, model.p85]);
  const maxY = Math.max(1, ...points.map((point) => point.y), ...thresholds);
  const yMax = Math.ceil(maxY * 1.15);
  const yTicks = buildTicks(yMax);
  const maxPointOffset = columns.length > 1
    ? Math.max(0, Math.min(34, (columnStep / 2) - 8))
    : Math.max(0, Math.min(44, (plotWidth / 2) - 8));
  const pointLayouts = layoutColumnPoints(viewModel, columns, yForDays, maxPointOffset);
  const columnIndexByName = new Map(columns.map((column, index) => [column, index]));

  function xForColumn(index: number): number {
    return margin.left + (columns.length === 1 ? plotWidth / 2 : index * columnStep);
  }

  function yForDays(days: number): number {
    return margin.top + plotHeight - (Math.min(days, yMax) / yMax) * plotHeight;
  }

  return (
    <div style={{ height, overflowX: 'auto' }} aria-label="Column aging scatter plot">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Column aging scatter plot" style={{ minWidth: '48rem', width: '100%', height: '100%' }}>
        <line
          x1={margin.left}
          x2={width - margin.right}
          y1={margin.top + plotHeight}
          y2={margin.top + plotHeight}
          stroke={palette.line}
        />
        <line
          x1={margin.left}
          x2={margin.left}
          y1={margin.top}
          y2={margin.top + plotHeight}
          stroke={palette.line}
        />

        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={yForDays(tick)}
              y2={yForDays(tick)}
              stroke={palette.line}
              opacity={0.55}
            />
            <text x={margin.left - 10} y={yForDays(tick) + 4} textAnchor="end" fill={palette.soft} fontSize={11}>
              {tick}d
            </text>
          </g>
        ))}

        {columns.map((column, index) => {
          const x = xForColumn(index);
          const model = viewModel.columnAgingModels.find((candidate) => candidate.columnName === column);
          const halfBand = columns.length > 1 ? Math.min(columnStep * 0.35, 46) : 56;
          return (
            <g key={column}>
              <line x1={x} x2={x} y1={margin.top} y2={margin.top + plotHeight} stroke={palette.line} opacity={0.35} />
              {model && model.p50 > 0 && (
                <ThresholdSegment x={x} y={yForDays(model.p50)} halfWidth={halfBand} color={palette.chartPositive} label="p50" />
              )}
              {model && model.p85 > 0 && (
                <ThresholdSegment x={x} y={yForDays(model.p85)} halfWidth={halfBand} color={palette.chartDanger} label="p85" />
              )}
              <text
                x={x}
                y={height - margin.bottom + 31}
                textAnchor="middle"
                fill={palette.soft}
                fontSize={11}
              >
                {truncate(column, 16)}
              </text>
              {model?.lowConfidenceReason && (
                <text x={x} y={height - margin.bottom + 47} textAnchor="middle" fill={palette.warning} fontSize={10}>
                  low confidence
                </text>
              )}
            </g>
          );
        })}

        <text
          x={margin.left + plotWidth / 2}
          y={height - 9}
          textAnchor="middle"
          fill={palette.soft}
          fontSize={12}
        >
          Current board column
        </text>
        <text
          x={-margin.top - plotHeight / 2}
          y={16}
          transform="rotate(-90)"
          textAnchor="middle"
          fill={palette.soft}
          fontSize={12}
        >
          Working days in current column
        </text>

        {viewModel.columnSeries.flatMap((serie) =>
          serie.data.map((point) => {
            const columnIndex = columnIndexByName.get(point.currentColumn);
            if (columnIndex === undefined) return null;
            const layoutKey = pointLayoutKey(serie.id, point);
            const x = xForColumn(columnIndex) + (pointLayouts.get(layoutKey) ?? 0);
            const y = yForDays(point.y);
            return (
              <g key={`${serie.id}-${point.workItemId}`} role="button" tabIndex={0} aria-label={`${point.issueKey}: ${point.y.toFixed(1)} working days in ${point.currentColumn}`}>
                <circle
                  cx={x}
                  cy={y}
                  r={6}
                  fill={zoneColors[point.agingZone]}
                  stroke={palette.panel}
                  strokeWidth={1.5}
                  style={{ cursor: onItemSelect ? 'pointer' : 'default' }}
                  onClick={() => onItemSelect?.(point.workItemId, point.issueKey)}
                >
                  <title>{buildTooltip(point)}</title>
                </circle>
              </g>
            );
          }),
        )}
      </svg>
    </div>
  );
}

function buildVisibleColumns(
  viewModel: FlowAnalyticsViewModel,
  points: ColumnScatterDatum[],
): string[] {
  const activeColumns = new Set(points.map((point) => point.currentColumn));
  const orderedColumns = viewModel.columnNames.filter((column) => activeColumns.has(column));
  const orderedSet = new Set(orderedColumns);
  for (const point of points) {
    if (!orderedSet.has(point.currentColumn)) {
      orderedColumns.push(point.currentColumn);
      orderedSet.add(point.currentColumn);
    }
  }
  return orderedColumns;
}

function ThresholdSegment({
  x,
  y,
  halfWidth,
  color,
  label,
}: {
  x: number;
  y: number;
  halfWidth: number;
  color: string;
  label: string;
}) {
  return (
    <g>
      <line
        x1={x - halfWidth}
        x2={x + halfWidth}
        y1={y}
        y2={y}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        opacity={0.85}
      />
      <text x={x + halfWidth + 4} y={y + 3} fill={color} fontSize={10}>
        {label}
      </text>
    </g>
  );
}

function buildTicks(max: number): number[] {
  const step = max <= 10 ? 2 : max <= 30 ? 5 : 10;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max; tick += step) ticks.push(tick);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}

function buildTooltip(point: ColumnScatterDatum): string {
  const durations = point.columnDurations
    .map((duration) => `${duration.columnName}: ${duration.workingDays.toFixed(1)}d`)
    .join('\n');
  return [
    `${point.issueKey}: ${point.summary}`,
    `${point.currentColumn}: ${point.y.toFixed(1)} working days`,
    point.onHoldNow ? 'On hold now' : 'Active',
    durations ? `All column durations:\n${durations}` : '',
  ].filter(Boolean).join('\n');
}

function layoutColumnPoints(
  viewModel: FlowAnalyticsViewModel,
  columns: string[],
  yForDays: (days: number) => number,
  maxOffset: number,
): Map<string, number> {
  const columnSet = new Set(columns);
  const pointsByColumn = new Map<string, Array<{ point: ColumnScatterDatum; serieId: ColumnScatterDatum['agingZone']; y: number }>>();

  for (const serie of viewModel.columnSeries) {
    for (const point of serie.data) {
      if (!columnSet.has(point.currentColumn)) continue;
      const columnPoints = pointsByColumn.get(point.currentColumn) ?? [];
      columnPoints.push({ point, serieId: serie.id, y: yForDays(point.y) });
      pointsByColumn.set(point.currentColumn, columnPoints);
    }
  }

  const offsets = new Map<string, number>();
  for (const columnPoints of pointsByColumn.values()) {
    const sorted = columnPoints.sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      return a.point.issueKey.localeCompare(b.point.issueKey) || a.point.workItemId.localeCompare(b.point.workItemId);
    });
    const clusters: typeof sorted[] = [];
    for (const item of sorted) {
      const currentCluster = clusters[clusters.length - 1];
      const previous = currentCluster?.[currentCluster.length - 1];
      if (!currentCluster || !previous || Math.abs(item.y - previous.y) > 14) {
        clusters.push([item]);
      } else {
        currentCluster.push(item);
      }
    }

    for (const cluster of clusters) {
      const clusterOffsets = buildOffsets(cluster.length, maxOffset);
      cluster.forEach((item, index) => {
        offsets.set(pointLayoutKey(item.serieId, item.point), clusterOffsets[index] ?? 0);
      });
    }
  }

  return offsets;
}

function buildOffsets(count: number, maxOffset: number): number[] {
  if (count <= 1 || maxOffset <= 0) return Array.from({ length: count }, () => 0);
  const spacing = Math.min(14, (maxOffset * 2) / (count - 1));
  return Array.from({ length: count }, (_, index) => (index - ((count - 1) / 2)) * spacing);
}

function pointLayoutKey(zone: ColumnScatterDatum['agingZone'], point: ColumnScatterDatum): string {
  return `${zone}:${point.workItemId}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
