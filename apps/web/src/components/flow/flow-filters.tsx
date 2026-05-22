'use client';

import { checkboxChipStyle, fieldLabelStyle, insetPanelStyle, palette, selectStyle, selectionControlStyle } from '@/components/app/chrome';

/** Active filter state passed around between FlowFiltersPanel and consumers. */
export interface FlowFilters {
  historicalWindowDays: number;
  issueTypeIds: string[];
  statusIds: string[];
  agingOnly: boolean;
  onHoldOnly: boolean;
}

export interface FilterOptions {
  issueTypes?: Array<{ id: string; name: string }>;
  statuses?: Array<{ id: string; name: string }>;
  historicalWindows?: number[];
}

interface FlowFiltersPanelProps {
  filterOptions: FilterOptions;
  filters: FlowFilters;
  onChange: (filters: FlowFilters) => void;
  disabled?: boolean;
}

interface GroupedStatusOption {
  name: string;
  statusIds: string[];
}

const DEFAULT_WINDOWS = [30, 60, 90, 180];

function groupStatuses(statuses: Array<{ id: string; name: string }>): GroupedStatusOption[] {
  const groups = new Map<string, GroupedStatusOption>();

  for (const status of statuses) {
    const existing = groups.get(status.name);
    if (existing) {
      if (!existing.statusIds.includes(status.id)) {
        existing.statusIds.push(status.id);
      }
      continue;
    }

    groups.set(status.name, { name: status.name, statusIds: [status.id] });
  }

  return Array.from(groups.values());
}

export function FlowFiltersPanel({
  filterOptions,
  filters,
  onChange,
  disabled,
}: FlowFiltersPanelProps) {
  function toggle(arr: string[], id: string): string[] {
    return arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
  }

  function toggleMany(arr: string[], ids: string[]): string[] {
    const allSelected = ids.every((id) => arr.includes(id));
    if (allSelected) {
      return arr.filter((id) => !ids.includes(id));
    }

    return [...arr, ...ids.filter((id) => !arr.includes(id))];
  }

  const groupedStatuses = groupStatuses(filterOptions.statuses ?? []);

  return (
    <div
      style={{
        ...insetPanelStyle,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
        fontSize: '0.875rem',
      }}
    >
      {/* Population: what data is in the analysis */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          alignItems: 'flex-start',
        }}
      >
        {/* Timeframe picker */}
        <div>
          <label
            htmlFor="flow-timeframe"
            style={{ ...fieldLabelStyle, marginBottom: '0.35rem' }}
          >
            Timeframe
          </label>
          <select
            id="flow-timeframe"
            value={filters.historicalWindowDays}
            onChange={(e) => onChange({ ...filters, historicalWindowDays: Number(e.target.value) })}
            disabled={disabled}
            style={{ ...selectStyle, minWidth: '7rem', width: 'auto', padding: '0.65rem 0.85rem' }}
            aria-label="Historical timeframe"
          >
            {(filterOptions.historicalWindows ?? DEFAULT_WINDOWS).map((w) => (
              <option key={w} value={w}>
                {w}d
              </option>
            ))}
          </select>
        </div>

        {/* Issue-type checkboxes */}
        {filterOptions.issueTypes && filterOptions.issueTypes.length > 0 && (
          <div>
            <p style={{ ...fieldLabelStyle, margin: '0 0 0.35rem' }}>
              Issue Types
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {filterOptions.issueTypes.map((t) => (
                <label
                  key={t.id}
                  style={checkboxChipStyle(filters.issueTypeIds.includes(t.id))}
                >
                  <input
                    type="checkbox"
                    checked={filters.issueTypeIds.includes(t.id)}
                    onChange={() =>
                      onChange({ ...filters, issueTypeIds: toggle(filters.issueTypeIds, t.id) })
                    }
                    disabled={disabled}
                    style={selectionControlStyle}
                    aria-label={`Filter by ${t.name}`}
                  />
                  {t.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Workflow-status checkboxes */}
        {groupedStatuses.length > 0 && (
          <div>
            <p style={{ ...fieldLabelStyle, margin: '0 0 0.35rem' }}>Status</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {groupedStatuses.map((statusGroup) => (
                <label
                  key={statusGroup.name}
                  style={checkboxChipStyle(statusGroup.statusIds.every((id) => filters.statusIds.includes(id)))}
                >
                  <input
                    type="checkbox"
                    checked={statusGroup.statusIds.every((id) => filters.statusIds.includes(id))}
                    onChange={() =>
                      onChange({
                        ...filters,
                        statusIds: toggleMany(filters.statusIds, statusGroup.statusIds),
                      })
                    }
                    disabled={disabled}
                    style={selectionControlStyle}
                    aria-label={`Filter by status ${statusGroup.name}`}
                  />
                  {statusGroup.name}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Hairline divider between population and highlight sections */}
      <div
        aria-hidden="true"
        style={{ height: 1, background: palette.line, width: '100%' }}
      />

      {/* Highlight: narrow what is shown from the population above */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          alignItems: 'center',
        }}
      >
        <p
          style={{
            ...fieldLabelStyle,
            margin: 0,
            marginRight: '0.25rem',
          }}
        >
          Highlight
        </p>
        <label style={checkboxChipStyle(filters.agingOnly)}>
          <input
            type="checkbox"
            checked={filters.agingOnly}
            onChange={(e) => onChange({ ...filters, agingOnly: e.target.checked })}
            disabled={disabled}
            style={selectionControlStyle}
          />
          Aging only
        </label>
        <label style={checkboxChipStyle(filters.onHoldOnly)}>
          <input
            type="checkbox"
            checked={filters.onHoldOnly}
            onChange={(e) => onChange({ ...filters, onHoldOnly: e.target.checked })}
            disabled={disabled}
            style={selectionControlStyle}
          />
          On-hold only
        </label>
      </div>
    </div>
  );
}
