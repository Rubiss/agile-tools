'use client';

import { useEffect, useRef, useState } from 'react';
import type { WorkItemDetail } from '@agile-tools/shared/contracts/api';
import { linkStyle, palette, sectionTitleStyle } from '@/components/app/chrome';

interface WorkItemDetailDrawerProps {
  scopeId: string;
  workItemId: string | null;
  issueKey?: string;
  onClose: () => void;
}

export function WorkItemDetailDrawer({
  scopeId,
  workItemId,
  issueKey,
  onClose,
}: WorkItemDetailDrawerProps) {
  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!workItemId) {
      setDetail(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    setDetail(null);

    fetch(`/api/v1/scopes/${scopeId}/items/${workItemId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<WorkItemDetail>;
      })
      .then((data) => {
        setDetail(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load item detail.');
        setLoading(false);
      });
  }, [scopeId, workItemId]);

  useEffect(() => {
    if (!workItemId) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [onClose, workItemId]);

  if (!workItemId) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: palette.overlay,
        display: 'flex',
        justifyContent: 'flex-end',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Work item detail: ${issueKey ?? workItemId}`}
        ref={dialogRef}
        tabIndex={-1}
        style={{
          width: 'min(26rem, 100vw)',
          height: '100%',
          marginLeft: 'auto',
          background: palette.panelStrong,
          borderLeft: `1px solid ${palette.lineStrong}`,
          boxShadow: palette.shadowCard,
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'hidden',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1rem',
            borderBottom: `1px solid ${palette.line}`,
            flexShrink: 0,
          }}
        >
          <h3 style={{ ...sectionTitleStyle, fontSize: '1.3rem' }}>{issueKey ?? 'Work Item'}</h3>
          <button
            onClick={onClose}
            aria-label="Close detail drawer"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.25rem',
              color: palette.soft,
              lineHeight: 1,
              padding: '0.25rem',
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', fontSize: '0.875rem' }}>
          {loading && <p style={{ color: palette.soft }}>Loading…</p>}
          {error && <p style={{ color: palette.danger }}>{error}</p>}
          {detail && <WorkItemDetailContent detail={detail} />}
        </div>
      </div>
    </div>
  );
}

function WorkItemDetailContent({ detail }: { detail: WorkItemDetail }) {
  return (
    <div>
      <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>{detail.summary}</p>
      <p style={{ margin: '0 0 0.25rem', color: palette.soft }}>
        Status:{' '}
        <strong style={{ color: palette.ink }}>{detail.currentStatus}</strong>
      </p>
      <p style={{ margin: '0 0 0.25rem', color: palette.soft }}>
        Age:{' '}
        <strong style={{ color: palette.ink }}>{detail.ageDays.toFixed(1)} days</strong>
      </p>
      {detail.jiraUrl && (
        <p style={{ margin: '0 0 1rem' }}>
          <a
            href={detail.jiraUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={linkStyle}
          >
            View in Jira ↗
          </a>
        </p>
      )}

      {detail.columnDurations && detail.columnDurations.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', color: palette.text }}>
            Column Durations
          </h4>
          <div style={{ display: 'grid', gap: '0.45rem' }}>
            {detail.columnDurations.map((duration) => (
              <div
                key={duration.columnName}
                style={{
                  padding: '0.6rem 0.7rem',
                  borderRadius: '12px',
                  border: `1px solid ${palette.line}`,
                  background: palette.panel,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                  <strong style={{ color: palette.ink }}>{duration.columnName}</strong>
                  <span style={{ color: duration.current ? palette.chartWarning : palette.text }}>
                    {duration.workingDays.toFixed(1)}d
                  </span>
                </div>
                <div style={{ marginTop: '0.25rem', color: palette.soft, fontSize: '0.75rem' }}>
                  {duration.visitCount} visit{duration.visitCount === 1 ? '' : 's'}
                  {duration.holdWorkingDays > 0 && ` · ${duration.holdWorkingDays.toFixed(1)}d on hold`}
                  {duration.current && ' · current'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.holdPeriods.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', color: palette.text }}>
            Hold Periods ({detail.holdPeriods.length})
          </h4>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {detail.holdPeriods.map((hp, i) => (
              <li key={i} style={{ marginBottom: '0.25rem' }}>
                {new Date(hp.startedAt).toLocaleDateString()}
                {hp.endedAt
                  ? ` – ${new Date(hp.endedAt).toLocaleDateString()}`
                  : ' – present'}
                {hp.sourceValue && (
                  <span style={{ color: palette.soft }}> ({hp.sourceValue})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.lifecycleEvents.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', color: palette.text }}>
            Timeline ({detail.lifecycleEvents.length} events)
          </h4>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.8125rem' }}>
            {detail.lifecycleEvents.map((ev, i) => (
              <li key={i} style={{ marginBottom: '0.25rem', color: palette.soft }}>
                {new Date(ev.changedAt).toLocaleDateString()}{' '}
                <span style={{ color: palette.ink }}>{ev.eventType}</span>
                {ev.fromStatus && ev.toStatus && ` : ${ev.fromStatus} → ${ev.toStatus}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
