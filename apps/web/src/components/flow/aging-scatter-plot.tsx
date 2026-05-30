'use client';

import { ResponsiveScatterPlot } from '@nivo/scatterplot';
import type {
  ScatterPlotLayerProps,
  ScatterPlotNodeData,
} from '@nivo/scatterplot';
import type { ScatterDatum, FlowAnalyticsViewModel } from '@/server/views/flow-analytics';
import type { AgingModel } from '@agile-tools/shared/contracts/api';
import { palette } from '@/components/app/chrome';

const scatterColors = {
  positive: palette.chartPositive,
  warning: palette.chartWarning,
  danger: palette.chartDanger,
  neutral: palette.chartNeutral,
  hold: palette.chartHold,
  ink: palette.ink,
  text: palette.text,
  soft: palette.soft,
  line: palette.line,
  lineStrong: palette.lineStrong,
  panel: palette.panel,
  panelStrong: palette.panelStrong,
};

const scatterZoneColors: Record<ScatterDatum['agingZone'], string> = {
  normal: scatterColors.positive,
  watch: scatterColors.warning,
  aging: scatterColors.danger,
};

const scatterZoneSurfaces: Record<ScatterDatum['agingZone'], { accent: string; glow: string }> = {
  normal: {
    accent: 'color-mix(in srgb, var(--chart-positive) 30%, transparent)',
    glow: 'linear-gradient(135deg, color-mix(in srgb, var(--chart-positive) 22%, transparent), transparent 68%)',
  },
  watch: {
    accent: 'color-mix(in srgb, var(--chart-warning) 34%, transparent)',
    glow: 'linear-gradient(135deg, color-mix(in srgb, var(--chart-warning) 24%, transparent), transparent 68%)',
  },
  aging: {
    accent: 'color-mix(in srgb, var(--chart-danger) 32%, transparent)',
    glow: 'linear-gradient(135deg, color-mix(in srgb, var(--chart-danger) 24%, transparent), transparent 68%)',
  },
};

function isScatterZone(value: string): value is ScatterDatum['agingZone'] {
  return value === 'normal' || value === 'watch' || value === 'aging';
}

/** Render dashed vertical reference lines at the p50, p70, and p85 thresholds. */
function createThresholdLayer(
  agingModel: AgingModel,
  colors: { positive: string; warning: string; danger: string },
) {
  return function ThresholdLines({
    xScale,
    innerHeight,
  }: ScatterPlotLayerProps<ScatterDatum>) {
    const thresholds = [
      { value: agingModel.p50, label: 'p50', color: colors.positive },
      { value: agingModel.p70, label: 'p70', color: colors.warning },
      { value: agingModel.p85, label: 'p85', color: colors.danger },
    ].filter((t) => t.value > 0);

    if (thresholds.length === 0) return null;

    const scale = xScale as (v: number) => number;

    return (
      <>
        {thresholds.map((t) => {
          const x = scale(t.value);
          return (
            <g key={t.label}>
              <line
                x1={x}
                x2={x}
                y1={0}
                y2={innerHeight}
                stroke={t.color}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                opacity={0.75}
              />
              <text x={x + 3} y={14} fontSize={10} fill={t.color} opacity={0.9}>
                {t.label}
              </text>
            </g>
          );
        })}
      </>
    );
  };
}

interface AgingScatterPlotProps {
  viewModel: FlowAnalyticsViewModel;
  onItemSelect?: (workItemId: string, issueKey: string) => void;
  height?: number;
}

export function AgingScatterTooltipCard({
  datum,
  ageDays,
}: {
  datum: ScatterDatum;
  ageDays: number;
}) {
  const surface = scatterZoneSurfaces[datum.agingZone];
  const zoneLabel =
    datum.agingZone === 'aging'
      ? 'Needs attention'
      : datum.agingZone === 'watch'
        ? 'Watchlist'
        : 'Healthy';
  const statusLine =
    datum.currentColumn && datum.currentColumn !== datum.currentStatus
      ? `${datum.currentStatus} · ${datum.currentColumn}`
      : datum.currentStatus;

  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: `radial-gradient(circle at top right, ${surface.accent}, transparent 46%), ${scatterColors.panel}`,
        border: `1px solid ${scatterColors.lineStrong}`,
        borderRadius: '18px',
        padding: '0.95rem 1rem 0.9rem',
        fontSize: '0.8125rem',
        boxShadow: palette.shadowCard,
        width: '19.5rem',
        maxWidth: 'calc(100vw - 2rem)',
        color: scatterColors.text,
        backdropFilter: 'blur(16px)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background: surface.glow,
          pointerEvents: 'none',
        }}
      />
      <div style={{ position: 'relative', display: 'grid', gap: '0.8rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '0.75rem',
            alignItems: 'flex-start',
          }}
        >
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <strong
                style={{
                  color: scatterColors.ink,
                  fontFamily: 'var(--font-display)',
                  fontSize: '1rem',
                  letterSpacing: '-0.03em',
                }}
              >
                {datum.issueKey}
              </strong>
              {datum.issueType && (
                <span
                  style={{
                    padding: '0.18rem 0.45rem',
                    borderRadius: '999px',
                    border: `1px solid ${scatterColors.line}`,
                    color: scatterColors.soft,
                    background: scatterColors.panelStrong,
                    fontSize: '0.66rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    fontWeight: 700,
                  }}
                >
                  {datum.issueType}
                </span>
              )}
            </div>
            <div
              style={{
                marginTop: '0.34rem',
                color: scatterColors.text,
                lineHeight: 1.45,
                fontSize: '0.86rem',
                overflowWrap: 'break-word',
              }}
            >
              {datum.summary}
            </div>
          </div>
          <span
            style={{
              flexShrink: 0,
              padding: '0.28rem 0.55rem',
              borderRadius: '999px',
              background: surface.accent,
              color: scatterZoneColors[datum.agingZone],
              border: `1px solid ${scatterZoneColors[datum.agingZone]}`,
              fontSize: '0.66rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            {zoneLabel}
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: '0.55rem',
          }}
        >
          <TooltipStat label="Status" value={statusLine} />
          <TooltipStat label="Assigned" value={datum.assigneeName ?? 'Unassigned'} />
          <TooltipStat label="Age" value={`${ageDays.toFixed(1)} days`} />
          <TooltipStat
            label="Hold"
            value={datum.onHoldNow ? 'On hold now' : 'Active'}
            {...(datum.onHoldNow ? { highlight: scatterColors.hold } : {})}
          />
        </div>
      </div>
    </div>
  );
}

export function AgingScatterPlot({
  viewModel,
  onItemSelect,
  height = 360,
}: AgingScatterPlotProps) {
  const { series, agingModel } = viewModel;
  const isEmpty = series.every((s) => s.data.length === 0);

  // Recreated on every render; fine because agingModel only changes on new data loads.
  const thresholdLayer = createThresholdLayer(agingModel, scatterColors);

  if (isEmpty) {
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
        No active work items to display.
      </div>
    );
  }

  return (
    <div style={{ height }} aria-label="Aging scatter plot">
      <ResponsiveScatterPlot<ScatterDatum>
        data={series}
        margin={{ top: 20, right: 20, bottom: 52, left: 50 }}
        xScale={{ type: 'linear', min: 0, max: 'auto' }}
        yScale={{ type: 'linear', min: -1, max: 'auto' }}
        axisBottom={{
          legend: 'Working days since started',
          legendOffset: 42,
          legendPosition: 'middle',
        }}
        axisLeft={null}
        enableGridY={false}
        theme={{
          text: {
            fill: scatterColors.soft,
            fontSize: 12,
          },
          axis: {
            domain: {
              line: {
                stroke: scatterColors.line,
              },
            },
            ticks: {
              line: {
                stroke: scatterColors.line,
              },
              text: {
                fill: scatterColors.soft,
              },
            },
            legend: {
              text: {
                fill: scatterColors.soft,
              },
            },
          },
          grid: {
            line: {
              stroke: scatterColors.line,
            },
          },
          crosshair: {
            line: {
              stroke: scatterColors.soft,
              strokeWidth: 1,
              strokeOpacity: 0.5,
            },
          },
        }}
        colors={({ serieId }: { serieId: string | number }) => {
          const zone = String(serieId);
          return isScatterZone(zone) ? scatterZoneColors[zone] : scatterColors.neutral;
        }}
        nodeSize={10}
        useMesh={false}
        layers={[
          'grid',
          'axes',
          thresholdLayer,
          'nodes',
          'legends',
          'annotations',
        ]}
        tooltip={({ node }: { node: ScatterPlotNodeData<ScatterDatum> }) => (
          <AgingScatterTooltipCard datum={node.data} ageDays={node.xValue} />
        )}
        onClick={(node: ScatterPlotNodeData<ScatterDatum>) => {
          onItemSelect?.(node.data.workItemId, node.data.issueKey);
        }}
        ariaLabel="Aging scatter plot"
      />
    </div>
  );
}

function TooltipStat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: string;
}) {
  return (
    <div
      style={{
        padding: '0.58rem 0.62rem 0.55rem',
        borderRadius: '14px',
        border: `1px solid ${palette.line}`,
        background: palette.panelStrong,
        minWidth: 0,
      }}
    >
      <div
        style={{
          color: palette.soft,
          fontSize: '0.62rem',
          fontWeight: 700,
          letterSpacing: '0.13em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: '0.28rem',
          color: highlight ?? palette.ink,
          fontSize: '0.8rem',
          fontWeight: 600,
          lineHeight: 1.35,
          overflowWrap: 'break-word',
        }}
      >
        {value}
      </div>
    </div>
  );
}
