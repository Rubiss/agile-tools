'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import {
  appendSampleWindowSearchParams,
  formatSampleWindowLabel,
  type NormalizedSampleWindow,
} from '@agile-tools/shared';
import type {
  EpicForecastResponse,
  EpicForecastTarget,
  EpicStoryCountSource,
} from '@agile-tools/shared/contracts/epic-forecast';
import {
  buttonStyle,
  fieldLabelStyle,
  helperTextStyle,
  inputStyle,
  insetPanelStyle,
  noticeStyle,
  palette,
  sectionCopyStyle,
  statCardStyle,
  statLabelStyle,
  statValueStyle,
} from '@/components/app/chrome';

interface EpicForecastPanelProps {
  scopeId: string;
  sampleWindow: NormalizedSampleWindow;
  dataVersion?: string | null;
  disabled?: boolean;
}

interface ProblemResponse {
  message?: string;
  details?: string[];
}

interface EpicLookupResponse {
  jiraIssueKey: string;
  summary: string;
  dueDate: string | null;
  epicLinkStoryCount: number;
  jiraStoryCount: number | null;
  directUrl: string;
}

function getProblemMessage(problem: ProblemResponse | null, fallbackMessage: string): string {
  return problem?.details?.[0] ?? problem?.message ?? fallbackMessage;
}

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDueDate(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function chanceTone(chance: number): 'positive' | 'warning' | 'danger' {
  if (chance >= 85) return 'positive';
  if (chance >= 60) return 'warning';
  return 'danger';
}

export function EpicForecastPanel({
  scopeId,
  sampleWindow,
  dataVersion,
  disabled,
}: EpicForecastPanelProps) {
  const [response, setResponse] = useState<EpicForecastResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookupMessage, setLookupMessage] = useState<string | null>(null);
  const [hoveredChanceTargetId, setHoveredChanceTargetId] = useState<string | null>(null);
  const [draggedTargetId, setDraggedTargetId] = useState<string | null>(null);
  const [dragOverTargetId, setDragOverTargetId] = useState<string | null>(null);
  const [jiraIssueKey, setJiraIssueKey] = useState('');
  const [summary, setSummary] = useState('');
  const [dueDate, setDueDate] = useState(dateOffset(60));
  const [remainingStoryCount, setRemainingStoryCount] = useState(10);
  const [storyCountSource, setStoryCountSource] = useState<EpicStoryCountSource>('manual');

  const loadEpicForecast = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    appendSampleWindowSearchParams(params, sampleWindow);
    if (dataVersion) {
      params.set('dataVersion', dataVersion);
    }

    try {
      const res = await fetch(
        `/api/v1/scopes/${scopeId}/epic-forecasts?${params.toString()}`,
        signal ? { signal } : undefined,
      );
      const body = (await res.json().catch(() => null)) as EpicForecastResponse | ProblemResponse | null;
      if (!res.ok) {
        throw new Error(getProblemMessage(body as ProblemResponse | null, `HTTP ${res.status}`));
      }
      setResponse(body as EpicForecastResponse);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load epic forecasts.');
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [dataVersion, sampleWindow, scopeId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadEpicForecast(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadEpicForecast]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/scopes/${scopeId}/epic-forecasts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jiraIssueKey,
          summary,
          dueDate,
          remainingStoryCount,
          storyCountSource,
          manualStoryCount: storyCountSource === 'manual' ? remainingStoryCount : null,
          epicLinkStoryCount: storyCountSource === 'epic_link' ? remainingStoryCount : null,
          jiraStoryCount: storyCountSource === 'jira_field' ? remainingStoryCount : null,
        }),
      });
      const body = (await res.json().catch(() => null)) as ProblemResponse | null;
      if (!res.ok) {
        throw new Error(getProblemMessage(body, `HTTP ${res.status}`));
      }
      setJiraIssueKey('');
      setSummary('');
      setDueDate(dateOffset(60));
      setRemainingStoryCount(10);
      setStoryCountSource('manual');
      await loadEpicForecast();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save epic forecast target.');
    } finally {
      setSaving(false);
    }
  }

  async function lookupEpic() {
    const normalizedKey = jiraIssueKey.trim();
    if (!normalizedKey) return;
    setLookupMessage('Loading epic details from Jira...');
    try {
      const params = new URLSearchParams({ issueKey: normalizedKey });
      const res = await fetch(`/api/v1/scopes/${scopeId}/epic-forecasts/lookup?${params.toString()}`);
      const body = (await res.json().catch(() => null)) as EpicLookupResponse | ProblemResponse | null;
      if (!res.ok) {
        throw new Error(getProblemMessage(body as ProblemResponse | null, `HTTP ${res.status}`));
      }
      const epic = body as EpicLookupResponse;
      setJiraIssueKey(epic.jiraIssueKey);
      setSummary(epic.summary);
      if (epic.dueDate) {
        setDueDate(epic.dueDate);
      }
      setStoryCountSource('epic_link');
      setRemainingStoryCount(Math.max(1, epic.epicLinkStoryCount));
      setLookupMessage(
        `Loaded summary${epic.dueDate ? ', due date' : ''}, and ${epic.epicLinkStoryCount} Epic Link ${epic.epicLinkStoryCount === 1 ? 'story' : 'stories'} from Jira.`,
      );
    } catch (err) {
      setLookupMessage(err instanceof Error ? err.message : 'Failed to load epic details from Jira.');
    }
  }

  async function removeTarget(targetId: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/scopes/${scopeId}/epic-forecasts/${targetId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ProblemResponse | null;
        throw new Error(getProblemMessage(body, `HTTP ${res.status}`));
      }
      await loadEpicForecast();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove epic forecast target.');
    } finally {
      setSaving(false);
    }
  }

  async function reorderTarget(sourceTargetId: string, destinationTargetId: string) {
    if (!response) return;
    if (sourceTargetId === destinationTargetId) return;

    const reorderedResults = [...activeResults];
    const sourceIndex = reorderedResults.findIndex((result) => result.targetId === sourceTargetId);
    const destinationIndex = reorderedResults.findIndex((result) => result.targetId === destinationTargetId);
    if (sourceIndex === -1 || destinationIndex === -1) return;

    const [movedResult] = reorderedResults.splice(sourceIndex, 1);
    if (!movedResult) return;
    reorderedResults.splice(destinationIndex, 0, movedResult);

    setSaving(true);
    setError(null);
    try {
      await Promise.all(
        reorderedResults.map((result, index) => {
          const target = response.targets.find((candidate) => candidate.id === result.targetId);
          return target ? saveTargetOrder(target, index + 1) : Promise.resolve();
        }),
      );
      await loadEpicForecast();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reorder epics.');
    } finally {
      setSaving(false);
    }
  }

  const busy = disabled || loading || saving;
  const activeResults = response?.results ?? [];
  const archivedTargets = response?.targets.filter((target) => target.status === 'closed') ?? [];

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <form
        onSubmit={(event) => { void handleSubmit(event); }}
        style={{ ...insetPanelStyle, display: 'grid', gap: '0.85rem' }}
      >
        <div style={{ display: 'grid', gap: '0.85rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <label>
            <span style={fieldLabelStyle}>Epic key</span>
            <input
              value={jiraIssueKey}
              onChange={(e) => setJiraIssueKey(e.target.value)}
              onBlur={() => { void lookupEpic(); }}
              disabled={busy}
              required
              placeholder="PROJ-123"
              style={inputStyle}
            />
          </label>
          <label>
            <span style={fieldLabelStyle}>Due date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={busy}
              required
              style={inputStyle}
            />
          </label>
          <label>
            <span style={fieldLabelStyle}>Story count source</span>
            <select
              value={storyCountSource}
              onChange={(e) => setStoryCountSource(e.target.value as EpicStoryCountSource)}
              disabled={busy}
              style={inputStyle}
            >
              <option value="manual">Manual override</option>
              <option value="epic_link">Epic Link children</option>
              <option value="jira_field">Jira story-count field</option>
            </select>
          </label>
          <label>
            <span style={fieldLabelStyle}>Remaining stories</span>
            <input
              type="number"
              min={1}
              value={remainingStoryCount}
              onChange={(e) => setRemainingStoryCount(Number(e.target.value))}
              disabled={busy}
              required
              style={inputStyle}
            />
          </label>
        </div>
        <label>
          <span style={fieldLabelStyle}>Epic summary</span>
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            disabled={busy}
            required
            placeholder="Customer-facing capability"
            style={inputStyle}
          />
        </label>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="submit" disabled={busy} style={buttonStyle('primary', busy)}>
            Save Epic
          </button>
          <p style={{ ...helperTextStyle, margin: 0 }}>
            Standard Jira due date is loaded when available. Drag active epics by the handle to choose the order.
          </p>
        </div>
      </form>

      {lookupMessage && (
        <div style={noticeStyle(lookupMessage.startsWith('Loaded') ? 'info' : 'warning')}>
          <p style={{ margin: 0 }}>{lookupMessage}</p>
        </div>
      )}

      {loading && <p style={sectionCopyStyle}>Loading epic stack rank...</p>}
      {error && (
        <div style={noticeStyle('danger')}>
          <p style={{ margin: 0 }}>{error}</p>
        </div>
      )}
      {response?.warnings.map((warning) => (
        <div key={warning.code} style={noticeStyle(warning.code === 'LOW_SAMPLE_SIZE' ? 'warning' : 'danger')}>
          <p style={{ margin: 0 }}>{warning.message}</p>
        </div>
      ))}

      {response && activeResults.length === 0 && !loading ? (
        <div style={insetPanelStyle}>
          <p style={{ ...sectionCopyStyle, margin: 0 }}>
            No epic targets are configured for this scope yet.
          </p>
        </div>
      ) : null}

      {response && activeResults.length > 0 ? (
        <div style={{ display: 'grid', gap: '0.85rem' }}>
          {activeResults.map((result) => {
            const tone = chanceTone(result.completionChance);
            const target = response.targets.find((candidate) => candidate.id === result.targetId);
            const percentileSummary = formatPercentileSummary(result.completionDatePercentiles);
            return (
              <article
                key={result.targetId}
                onDragOver={(event) => {
                  if (busy || !draggedTargetId) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setDragOverTargetId(result.targetId);
                }}
                onDragLeave={() => {
                  if (dragOverTargetId === result.targetId) {
                    setDragOverTargetId(null);
                  }
                }}
                onPointerEnter={() => {
                  if (!busy && draggedTargetId && draggedTargetId !== result.targetId) {
                    setDragOverTargetId(result.targetId);
                  }
                }}
                onPointerUp={() => {
                  const sourceTargetId = draggedTargetId;
                  setDraggedTargetId(null);
                  setDragOverTargetId(null);
                  if (sourceTargetId) {
                    void reorderTarget(sourceTargetId, result.targetId);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceTargetId = event.dataTransfer.getData('text/plain') || draggedTargetId;
                  setDraggedTargetId(null);
                  setDragOverTargetId(null);
                  if (sourceTargetId) {
                    void reorderTarget(sourceTargetId, result.targetId);
                  }
                }}
                style={{
                  ...statCardStyle,
                  display: 'grid',
                  gap: '0.9rem',
                  gridTemplateColumns: '2.5rem minmax(0, 1.2fr) repeat(3, minmax(110px, 0.35fr)) 2.5rem',
                  alignItems: 'center',
                  outline: dragOverTargetId === result.targetId ? `2px solid ${palette.accentStrong}` : undefined,
                  opacity: draggedTargetId === result.targetId ? 0.72 : 1,
                }}
              >
                <div
                  role="button"
                  tabIndex={busy ? -1 : 0}
                  draggable={!busy}
                  aria-disabled={busy}
                  aria-label={`Drag ${result.jiraIssueKey} to reorder`}
                  title={`Drag ${result.jiraIssueKey} to reorder`}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', result.targetId);
                    setDraggedTargetId(result.targetId);
                  }}
                  onPointerDown={() => {
                    if (!busy) {
                      setDraggedTargetId(result.targetId);
                    }
                  }}
                  onDragEnd={() => {
                    setDraggedTargetId(null);
                    setDragOverTargetId(null);
                  }}
                  style={dragHandleButtonStyle(busy)}
                >
                  <DragGripIcon />
                </div>
                <div style={{ minWidth: 0 }}>
                  <p style={{ ...statLabelStyle, marginBottom: '0.35rem' }}>
                    {target?.directUrl ? (
                      <a
                        href={target.directUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={activeEpicLinkStyle}
                        title={`Open ${result.jiraIssueKey} in Jira`}
                      >
                        {result.jiraIssueKey} ↗
                      </a>
                    ) : result.jiraIssueKey}
                  </p>
                  <p style={{ margin: 0, color: palette.ink, fontWeight: 700 }}>{result.summary}</p>
                </div>
                <div>
                  <p style={statLabelStyle}>Due</p>
                  <p style={{ margin: '0.35rem 0 0', color: palette.text, fontWeight: 700 }}>
                    {formatDueDate(result.dueDate)}
                  </p>
                </div>
                <div>
                  <p style={statLabelStyle}>Stories</p>
                  <p style={{ margin: '0.35rem 0 0', color: palette.text, fontWeight: 700 }}>
                    {result.remainingStoryCount}
                  </p>
                  {target ? (
                    <p style={{ margin: '0.2rem 0 0', color: palette.soft, fontSize: '0.78rem' }}>
                      {formatStorySource(target)}
                    </p>
                  ) : null}
                </div>
                <div>
                  <p style={statLabelStyle}>Chance</p>
                  <p
                    title={`Chance is the share of Monte Carlo simulations that complete cumulative stories by the due date.\n${percentileSummary}`}
                    tabIndex={0}
                    onFocus={() => setHoveredChanceTargetId(result.targetId)}
                    onBlur={() => setHoveredChanceTargetId(null)}
                    onMouseEnter={() => setHoveredChanceTargetId(result.targetId)}
                    onMouseLeave={() => setHoveredChanceTargetId(null)}
                    style={{ ...statValueStyle, color: palette[tone], fontSize: '1.35rem' }}
                  >
                    {result.completionChance.toFixed(1)}%
                  </p>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { void removeTarget(result.targetId); }}
                    style={iconButtonStyle(busy)}
                    aria-label={`Remove ${result.jiraIssueKey}`}
                    title={`Remove ${result.jiraIssueKey}`}
                  >
                    ×
                  </button>
                </div>
                {hoveredChanceTargetId === result.targetId ? (
                  <div
                    role="tooltip"
                    style={{
                      gridColumn: '1 / -1',
                      padding: '0.7rem',
                      borderRadius: '0.5rem',
                      border: `1px solid ${palette.line}`,
                      background: palette.panel,
                      boxShadow: '0 12px 28px rgba(15, 23, 42, 0.18)',
                      color: palette.text,
                      fontSize: '0.78rem',
                      lineHeight: 1.45,
                    }}
                  >
                    <strong style={{ color: palette.ink }}>
                      Chance is the share of simulations completed by due date.
                    </strong>
                    <div style={{ marginTop: '0.35rem' }}>{percentileSummary}</div>
                  </div>
                ) : null}
              </article>
            );
          })}
          <div style={{ ...insetPanelStyle, color: palette.soft, fontSize: '0.75rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <span>
              Sample size: <strong style={{ color: palette.text }}>{response.sampleSize} stories</strong>
            </span>
            <span>
              Window: <strong style={{ color: palette.text }}>{formatSampleWindowLabel(response)}</strong>
            </span>
            <span>
              Iterations: <strong style={{ color: palette.text }}>{response.iterations.toLocaleString()}</strong>
            </span>
          </div>
        </div>
      ) : null}

      {archivedTargets.length > 0 ? (
        <div style={{ ...insetPanelStyle, display: 'grid', gap: '0.75rem' }}>
          <div>
            <p style={{ ...fieldLabelStyle, marginBottom: '0.25rem' }}>Archived / completed</p>
            <p style={{ ...sectionCopyStyle, margin: 0 }}>
              Closed epics are retained here for auditability and excluded from the active stack-rank simulation.
            </p>
          </div>
          <div style={{ display: 'grid', gap: '0.55rem' }}>
            {archivedTargets.map((target) => (
              <div
                key={target.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(8rem, 0.3fr) minmax(0, 1fr) minmax(9rem, 0.3fr)',
                  gap: '0.75rem',
                  alignItems: 'center',
                  color: palette.muted,
                }}
              >
                <strong style={{ color: palette.text }}>
                  {target.directUrl ? (
                    <a href={target.directUrl} target="_blank" rel="noreferrer" style={activeEpicLinkStyle}>
                      {target.jiraIssueKey} ↗
                    </a>
                  ) : target.jiraIssueKey}
                </strong>
                <span>{target.summary}</span>
                <span>{target.closedAt ? formatDueDate(target.closedAt.slice(0, 10)) : 'Closed'}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

async function saveTargetOrder(target: EpicForecastTarget, sortOrder: number): Promise<void> {
  const res = await fetch(`/api/v1/scopes/${target.scopeId}/epic-forecasts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jiraIssueKey: target.jiraIssueKey,
      summary: target.summary,
      dueDate: target.dueDate,
      remainingStoryCount: target.remainingStoryCount,
      storyCountSource: target.storyCountSource,
      epicLinkStoryCount: target.epicLinkStoryCount,
      jiraStoryCount: target.jiraStoryCount,
      manualStoryCount: target.manualStoryCount,
      status: target.status,
      closedAt: target.closedAt,
      sortOrder,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ProblemResponse | null;
    throw new Error(getProblemMessage(body, `HTTP ${res.status}`));
  }
}

function formatStorySource(target: EpicForecastTarget): string {
  if (target.storyCountSource === 'epic_link') {
    return `Epic Link children: ${target.epicLinkStoryCount ?? target.remainingStoryCount}`;
  }
  if (target.storyCountSource === 'jira_field') {
    return `Jira field: ${target.jiraStoryCount ?? target.remainingStoryCount}`;
  }
  return `Manual override: ${target.manualStoryCount ?? target.remainingStoryCount}`;
}

function formatPercentileSummary(
  percentiles?: Array<{ confidenceLevel: number; completionDate?: string | undefined }>,
): string {
  if (!percentiles || percentiles.length === 0) {
    return 'Completion date percentiles are not available.';
  }
  return `Completion date percentiles: ${percentiles
    .map((percentile) =>
      percentile.completionDate
        ? `p${percentile.confidenceLevel}: ${formatDueDate(percentile.completionDate)}`
        : `p${percentile.confidenceLevel}: unavailable`,
    )
    .join(', ')}`;
}

const activeEpicLinkStyle: CSSProperties = {
  color: palette.accentStrong,
  textDecoration: 'underline',
  textDecorationThickness: '2px',
  textUnderlineOffset: '0.22rem',
};

function dragHandleButtonStyle(disabled: boolean): CSSProperties {
  return {
    width: '2.25rem',
    height: '2.25rem',
    display: 'inline-grid',
    placeItems: 'center',
    borderRadius: '0.5rem',
    border: `1px solid ${palette.line}`,
    background: disabled ? palette.buttonDisabled : palette.panelAlt,
    color: disabled ? palette.buttonDisabledText : palette.soft,
    cursor: disabled ? 'not-allowed' : 'grab',
    padding: 0,
    userSelect: 'none',
    touchAction: 'none',
  };
}

function iconButtonStyle(disabled: boolean): CSSProperties {
  return {
    width: '2.25rem',
    height: '2.25rem',
    display: 'inline-grid',
    placeItems: 'center',
    borderRadius: '999px',
    border: `1px solid ${disabled ? palette.line : palette.danger}`,
    background: disabled ? palette.buttonDisabled : palette.dangerSoft,
    color: disabled ? palette.buttonDisabledText : palette.danger,
    cursor: disabled ? 'not-allowed' : 'pointer',
    padding: 0,
    fontSize: '1.15rem',
    fontWeight: 800,
    lineHeight: 1,
  };
}

function DragGripIcon() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 0.24rem)',
        gridTemplateRows: 'repeat(3, 0.24rem)',
        gap: '0.16rem',
      }}
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <span
          key={index}
          style={{
            width: '0.24rem',
            height: '0.24rem',
            borderRadius: '999px',
            background: 'currentColor',
          }}
        />
      ))}
    </span>
  );
}
