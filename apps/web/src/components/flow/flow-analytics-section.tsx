'use client';

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { ColumnAgingModel, FlowAnalyticsResponse } from '@agile-tools/shared/contracts/api';
import { shapeFlowAnalytics, type FlowAnalyticsViewModel } from '@/server/views/flow-analytics';
import { FlowFiltersPanel } from './flow-filters';
import type { FlowFilters, FilterOptions } from './flow-filters';
import { AgingScatterPlot } from './aging-scatter-plot';
import { ColumnAgingScatterPlot } from './column-aging-scatter-plot';
import { AgingThresholdDrawer } from './aging-threshold-drawer';
import { WorkItemDetailDrawer } from './work-item-detail-drawer';
import { buttonStyle, codeStyle, insetPanelStyle, noticeStyle, palette, tonePillStyle } from '@/components/app/chrome';

interface FlowAnalyticsSectionProps {
  scopeId: string;
  filterOptions: FilterOptions;
  /** Optional content rendered between the analytics chart and the aging-thresholds summary. */
  footer?: ReactNode;
}

const DEFAULT_FILTERS: FlowFilters = {
  historicalWindowDays: 90,
  issueTypeIds: [],
  statusIds: [],
  agingOnly: false,
  onHoldOnly: false,
};

const FILTER_STORAGE_PREFIX = 'agile-tools:flow-filters:v1:';
const VIEW_STORAGE_PREFIX = 'agile-tools:flow-chart-view:v1:';
type FlowChartView = 'global' | 'column';

function storageKey(scopeId: string): string {
  return `${FILTER_STORAGE_PREFIX}${scopeId}`;
}

function viewStorageKey(scopeId: string): string {
  return `${VIEW_STORAGE_PREFIX}${scopeId}`;
}

/**
 * Read previously-persisted filters for the given scope. Returns `null` when no
 * value is stored, parsing fails, or every persisted id has dropped out of the
 * current filter options (e.g. the scope's issue types changed).
 */
/** Hard upper bound on persisted window to prevent localStorage-poisoned values reaching the API. */
const MAX_HISTORICAL_WINDOW_DAYS = 3650;

function discardStoredFilters(scopeId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey(scopeId));
  } catch {
    // Storage disabled — non-fatal.
  }
}

function loadStoredFilters(scopeId: string, options: FilterOptions): FlowFilters | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey(scopeId));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    discardStoredFilters(scopeId);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    discardStoredFilters(scopeId);
    return null;
  }
  const candidate = parsed as Partial<Record<keyof FlowFilters, unknown>>;

  const validIssueTypeIds = new Set((options.issueTypes ?? []).map((t) => t.id));
  const validStatusIds = new Set((options.statuses ?? []).map((s) => s.id));
  const validWindows = new Set(options.historicalWindows ?? []);

  const issueTypeIdsRaw = Array.isArray(candidate.issueTypeIds)
    ? candidate.issueTypeIds.filter((id): id is string => typeof id === 'string')
    : [];
  const issueTypeIds = issueTypeIdsRaw.filter((id) => validIssueTypeIds.has(id));
  // If every persisted issue-type filter has dropped out of the current options
  // (board schema change, etc.), discard the entry rather than silently widening
  // the filter from "only stories" to "everything".
  if (issueTypeIdsRaw.length > 0 && issueTypeIds.length === 0) {
    discardStoredFilters(scopeId);
    return null;
  }

  const statusIdsRaw = Array.isArray(candidate.statusIds)
    ? candidate.statusIds.filter((id): id is string => typeof id === 'string')
    : [];
  const statusIds = statusIdsRaw.filter((id) => validStatusIds.has(id));
  if (statusIdsRaw.length > 0 && statusIds.length === 0) {
    discardStoredFilters(scopeId);
    return null;
  }

  const hwd = candidate.historicalWindowDays;
  const hwdValid =
    typeof hwd === 'number'
    && Number.isInteger(hwd)
    && hwd > 0
    && hwd <= MAX_HISTORICAL_WINDOW_DAYS
    && (validWindows.size === 0 || validWindows.has(hwd));

  if (!hwdValid) {
    discardStoredFilters(scopeId);
    return null;
  }

  return {
    historicalWindowDays: hwd,
    issueTypeIds,
    statusIds,
    agingOnly: candidate.agingOnly === true,
    onHoldOnly: candidate.onHoldOnly === true,
  };
}

function saveStoredFilters(scopeId: string, filters: FlowFilters): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(scopeId), JSON.stringify(filters));
  } catch {
    // Quota/disabled storage — non-fatal.
  }
}

function loadStoredView(scopeId: string): FlowChartView {
  if (typeof window === 'undefined') return 'global';
  try {
    const value = window.localStorage.getItem(viewStorageKey(scopeId));
    return value === 'column' ? 'column' : 'global';
  } catch {
    return 'global';
  }
}

function saveStoredView(scopeId: string, view: FlowChartView): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(viewStorageKey(scopeId), view);
  } catch {
    // Quota/disabled storage — non-fatal.
  }
}

export function FlowAnalyticsSection({ scopeId, filterOptions, footer }: FlowAnalyticsSectionProps) {
  const [filters, setFilters] = useState<FlowFilters>({
    ...DEFAULT_FILTERS,
    historicalWindowDays: filterOptions.historicalWindows?.[2] ?? 90,
  });
  const [response, setResponse] = useState<FlowAnalyticsResponse | null>(null);
  const [chartView, setChartView] = useState<FlowChartView>('global');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected item for the detail drawer.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | undefined>(undefined);

  // Aging-threshold explanation drawer.
  const [thresholdDrawerOpen, setThresholdDrawerOpen] = useState(false);

  // Monotonic request-sequence guard: if a slower in-flight request resolves
  // after a newer one has been issued (e.g. rapid filter changes), the stale
  // response is dropped instead of clobbering the UI.
  const requestSeqRef = useRef(0);

  const fetchFlow = useCallback(
    async (f: FlowFilters) => {
      const mySeq = ++requestSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set('historicalWindowDays', String(f.historicalWindowDays));
        f.issueTypeIds.forEach((id) => params.append('issueTypeIds', id));
        f.statusIds.forEach((id) => params.append('statusIds', id));
        if (f.agingOnly) params.set('agingOnly', 'true');
        if (f.onHoldOnly) params.set('onHoldOnly', 'true');

        const res = await fetch(`/api/v1/scopes/${scopeId}/flow?${params.toString()}`);
        if (mySeq !== requestSeqRef.current) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as FlowAnalyticsResponse;
        if (mySeq !== requestSeqRef.current) return;
        setResponse(data);
      } catch (err) {
        if (mySeq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load flow analytics.');
      } finally {
        if (mySeq === requestSeqRef.current) setLoading(false);
      }
    },
    [scopeId],
  );

  useEffect(() => {
    setChartView(loadStoredView(scopeId));
    const stored = loadStoredFilters(scopeId, filterOptions);
    if (stored) {
      setFilters(stored);
      void fetchFlow(stored);
    } else {
      // No usable stored filters: derive defaults from the *current* scope's
      // options. Avoid reusing the previous scope's filter state on client nav.
      const defaults: FlowFilters = {
        ...DEFAULT_FILTERS,
        historicalWindowDays: filterOptions.historicalWindows?.[2] ?? 90,
      };
      setFilters(defaults);
      void fetchFlow(defaults);
    }
    // filterOptions/fetchFlow intentionally omitted: this effect models "scope
    // changed" and should not re-fire if a parent re-renders with a new options
    // object reference. fetchFlow already closes over scopeId.
  }, [scopeId]);

  function handleChartViewChange(next: FlowChartView) {
    setChartView(next);
    saveStoredView(scopeId, next);
  }

  function handleFilterChange(next: FlowFilters) {
    setFilters(next);
    saveStoredFilters(scopeId, next);
    void fetchFlow(next);
  }

  function handleItemSelect(workItemId: string, issueKey: string) {
    setSelectedItemId(workItemId);
    setSelectedIssueKey(issueKey);
  }

  const viewModel = response ? shapeFlowAnalytics(response) : null;

  return (
    <div>
      {/* Filters */}
      <FlowFiltersPanel
        filterOptions={filterOptions}
        filters={filters}
        onChange={handleFilterChange}
        disabled={loading}
      />

      {/* Warnings from API */}
      {response?.warnings && response.warnings.length > 0 && (
        <div style={{ ...noticeStyle('warning'), marginTop: '0.75rem', fontSize: '0.875rem' }}>
          {response.warnings.map((w, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : '0.25rem 0 0' }}>
              ⚠ {w.message}
            </p>
          ))}
        </div>
      )}

      {/* Scatter plot */}
      <div style={{ ...insetPanelStyle, marginTop: '0.85rem', position: 'relative' }}>
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: palette.panel,
              zIndex: 1,
              borderRadius: '20px',
            }}
          >
            <span style={{ color: palette.soft, fontSize: '0.875rem' }}>Loading…</span>
          </div>
        )}
        {error && (
          <p style={{ color: palette.danger, fontSize: '0.875rem', margin: 0 }}>{error}</p>
        )}
        {viewModel && !error && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }} aria-label="Flow analytics chart view">
                <button
                  type="button"
                  onClick={() => handleChartViewChange('global')}
                  style={buttonStyle(chartView === 'global' ? 'primary' : 'secondary')}
                >
                  Global aging
                </button>
                <button
                  type="button"
                  onClick={() => handleChartViewChange('column')}
                  style={buttonStyle(chartView === 'column' ? 'primary' : 'secondary')}
                >
                  Column aging
                </button>
              </div>
              <span style={{ color: palette.soft, fontSize: '0.8rem', alignSelf: 'center' }}>
                {chartView === 'column'
                  ? 'Current-column dwell with per-column thresholds.'
                  : 'Whole-flow age with global thresholds.'}
              </span>
            </div>
            {chartView === 'column' ? (
              <ColumnAgingScatterPlot
                viewModel={viewModel}
                onItemSelect={handleItemSelect}
              />
            ) : (
              <AgingScatterPlot
                viewModel={viewModel}
                onItemSelect={handleItemSelect}
              />
            )}
          </>
        )}
        {!viewModel && !loading && !error && (
          <p style={{ color: palette.soft, fontSize: '0.875rem' }}>No data available.</p>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.75rem', fontSize: '0.75rem', flexWrap: 'wrap' }}>
        {[
          { color: palette.chartPositive, label: 'Normal (≤ p50)' },
          { color: palette.chartWarning, label: 'Watch (p50–p85)' },
          { color: palette.chartDanger, label: 'Aging (> p85)' },
        ].map((item) => (
          <span key={item.label} style={{ ...tonePillStyle('neutral'), gap: '0.45rem' }}>
            <span
              style={{
                width: '0.75rem',
                height: '0.75rem',
                borderRadius: '50%',
                background: item.color,
                display: 'inline-block',
              }}
            />
            {item.label}
          </span>
        ))}
      </div>

      {/* Footer slot (e.g. admin hold-definition form) */}
      {footer && <div style={{ marginTop: '0.85rem' }}>{footer}</div>}

      {/* Aging model summary (moved to bottom) */}
      {response && (
        <div
          style={{
            ...insetPanelStyle,
            marginTop: '0.85rem',
            fontSize: '0.85rem',
            color: palette.muted,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '0.5rem 0.75rem',
          }}
        >
          {chartView === 'column' && viewModel ? (
            <ColumnThresholdSummary
              activeColumnNames={getActiveColumnNames(viewModel)}
              activeItemCount={response.sampleSize}
              columnAgingModels={response.columnAgingModels ?? []}
            />
          ) : (
            <GlobalThresholdSummary response={response} />
          )}
          <button
            type="button"
            onClick={() => setThresholdDrawerOpen(true)}
            style={{ ...buttonStyle('secondary'), marginLeft: 'auto' }}
          >
            How these thresholds were calculated
          </button>
        </div>
      )}

      {/* Work item detail drawer */}
      <WorkItemDetailDrawer
        scopeId={scopeId}
        workItemId={selectedItemId}
        {...(selectedIssueKey !== undefined && { issueKey: selectedIssueKey })}
        onClose={() => {
          setSelectedItemId(null);
          setSelectedIssueKey(undefined);
        }}
      />

      {/* Aging threshold explanation drawer */}
      {response && (
        <AgingThresholdDrawer
          open={thresholdDrawerOpen}
          agingModel={response.agingModel}
          mode={chartView}
          columnAgingModels={response.columnAgingModels ?? []}
          visibleColumnNames={viewModel ? getActiveColumnNames(viewModel) : []}
          historicalWindowDays={response.historicalWindowDays}
          activeItemCount={response.sampleSize}
          dataVersion={response.dataVersion}
          onClose={() => setThresholdDrawerOpen(false)}
        />
      )}
    </div>
  );
}

function GlobalThresholdSummary({ response }: { response: FlowAnalyticsResponse }) {
  return (
    <>
      {response.agingModel.sampleSize > 0 ? (
        <span>
          Thresholds (p50 / p70 / p85):{' '}
          <strong style={{ color: palette.ink }}>
            {response.agingModel.p50.toFixed(1)}d / {response.agingModel.p70.toFixed(1)}d / {response.agingModel.p85.toFixed(1)}d
          </strong>{' '}from {response.agingModel.sampleSize} completed stories
          <span style={{ marginLeft: '0.55rem' }}>
            <span style={codeStyle}>{response.sampleSize} active items</span>
          </span>
        </span>
      ) : (
        <span>No aging thresholds yet (sync more data)</span>
      )}
      {response.agingModel.lowConfidenceReason && (
        <span style={{ color: palette.warning }}>
          ⚠ {response.agingModel.lowConfidenceReason}
        </span>
      )}
      {response.columnAgingModels?.some((model) => model.lowConfidenceReason) && (
        <span style={{ color: palette.warning }}>
          ⚠ Some column thresholds have low-confidence samples.
        </span>
      )}
    </>
  );
}

function ColumnThresholdSummary({
  activeColumnNames,
  activeItemCount,
  columnAgingModels,
}: {
  activeColumnNames: string[];
  activeItemCount: number;
  columnAgingModels: ColumnAgingModel[];
}) {
  const modelsByColumn = new Map(columnAgingModels.map((model) => [model.columnName, model]));
  const activeModels = activeColumnNames
    .map((columnName) => modelsByColumn.get(columnName))
    .filter((model): model is ColumnAgingModel => Boolean(model));
  const modeledColumnCount = activeModels.filter((model) => model.sampleSize > 0).length;
  const lowConfidenceCount = activeModels.filter((model) => model.lowConfidenceReason).length;

  if (activeColumnNames.length === 0) {
    return <span>No current-column dwell data yet.</span>;
  }

  return (
    <>
      <span>
        Column thresholds:{' '}
        <strong style={{ color: palette.ink }}>
          {activeColumnNames.length} active {activeColumnNames.length === 1 ? 'column' : 'columns'}
        </strong>{' '}
        ({modeledColumnCount} with completed samples)
        <span style={{ marginLeft: '0.55rem' }}>
          <span style={codeStyle}>{activeItemCount} active items</span>
        </span>
      </span>
      <span>
        p50 / p70 / p85 are calculated per column from completed-story dwell time.
      </span>
      {activeModels.slice(0, 3).map((model) => (
        <span key={model.columnName} style={codeStyle}>
          {model.columnName}: {model.p50.toFixed(1)}d / {model.p70.toFixed(1)}d / {model.p85.toFixed(1)}d
        </span>
      ))}
      {activeModels.length > 3 && (
        <span style={codeStyle}>+{activeModels.length - 3} more columns</span>
      )}
      {lowConfidenceCount > 0 && (
        <span style={{ color: palette.warning }}>
          ⚠ {lowConfidenceCount} active {lowConfidenceCount === 1 ? 'column has' : 'columns have'} low-confidence samples.
        </span>
      )}
    </>
  );
}

function getActiveColumnNames(viewModel: FlowAnalyticsViewModel): string[] {
  const activeColumns = new Set(viewModel.columnSeries.flatMap((serie) => serie.data.map((point) => point.currentColumn)));
  const orderedColumns = viewModel.columnNames.filter((column) => activeColumns.has(column));
  const orderedSet = new Set(orderedColumns);
  for (const column of activeColumns) {
    if (!orderedSet.has(column)) {
      orderedColumns.push(column);
      orderedSet.add(column);
    }
  }
  return orderedColumns;
}
