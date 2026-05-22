'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { AgingModel } from '@agile-tools/shared/contracts/api';
import {
  codeStyle,
  eyebrowStyle,
  insetPanelStyle,
  noticeStyle,
  palette,
  sectionCopyStyle,
  sectionTitleStyle,
  statCardStyle,
  statGridStyle,
  statLabelStyle,
  statValueStyle,
} from '@/components/app/chrome';

/** Mirrors `AGING_CONFIDENCE_THRESHOLD` from `@agile-tools/analytics` (server-only package). */
const AGING_CONFIDENCE_THRESHOLD = 30;

interface AgingThresholdDrawerProps {
  open: boolean;
  agingModel: AgingModel;
  historicalWindowDays: number;
  activeItemCount: number;
  dataVersion: string;
  onClose: () => void;
}

function StepCard({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        ...insetPanelStyle,
        border: `1px solid ${palette.lineStrong}`,
        background: `linear-gradient(180deg, ${palette.panelAlt} 0%, ${palette.panelStrong} 100%)`,
      }}
    >
      <div style={{ display: 'flex', gap: '0.85rem', alignItems: 'flex-start' }}>
        <div
          aria-hidden="true"
          style={{
            width: '1.9rem',
            height: '1.9rem',
            borderRadius: '999px',
            background: palette.accentSoft,
            color: palette.accentStrong,
            display: 'grid',
            placeItems: 'center',
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            flexShrink: 0,
            boxShadow: `inset 0 0 0 1px ${palette.lineStrong}`,
          }}
        >
          {step}
        </div>
        <div style={{ flex: 1 }}>
          <h3 style={{ ...sectionTitleStyle, fontSize: '1.1rem', marginBottom: '0.35rem' }}>{title}</h3>
          {children}
        </div>
      </div>
    </section>
  );
}

export function AgingThresholdDrawer({
  open,
  agingModel,
  historicalWindowDays,
  activeItemCount,
  dataVersion,
  onClose,
}: AgingThresholdDrawerProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const hasSample = agingModel.sampleSize > 0;
  const lowConfidence = Boolean(agingModel.lowConfidenceReason);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: palette.overlay,
        display: 'flex',
        justifyContent: 'flex-end',
        zIndex: 60,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="How aging thresholds were calculated"
        ref={dialogRef}
        tabIndex={-1}
        style={{
          width: 'min(36rem, 100vw)',
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
            padding: '1.25rem 1.25rem 1rem',
            borderBottom: `1px solid ${palette.line}`,
            background: `linear-gradient(180deg, ${palette.panel} 0%, ${palette.panelStrong} 100%)`,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
            <div>
              <p style={eyebrowStyle}>Aging notebook</p>
              <h2 style={{ ...sectionTitleStyle, fontSize: '1.5rem', marginTop: '0.5rem' }}>
                How aging thresholds were calculated
              </h2>
              <p style={{ ...sectionCopyStyle, marginTop: '0.55rem', maxWidth: '28rem' }}>
                Inputs and method used to derive the p50 / p70 / p85 cycle-time thresholds that
                color each item in the scatter plot.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close aging threshold drawer"
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
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'grid', gap: '1rem' }}>
          <StepCard step={1} title="Inputs">
            <div style={statGridStyle}>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Historical window</p>
                <p style={{ ...statValueStyle, fontSize: '1.05rem' }}>{historicalWindowDays} days</p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Completed sample</p>
                <p style={{ ...statValueStyle, fontSize: '1.05rem' }}>
                  {agingModel.sampleSize} {agingModel.sampleSize === 1 ? 'story' : 'stories'}
                </p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Active items plotted</p>
                <p style={{ ...statValueStyle, fontSize: '1.05rem' }}>{activeItemCount}</p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Metric basis</p>
                <p style={{ ...statValueStyle, fontSize: '1.05rem' }}>Cycle time</p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Pinned snapshot</p>
                <p style={{ ...statValueStyle, fontSize: '0.92rem' }}>
                  <span style={codeStyle}>{dataVersion || '—'}</span>
                </p>
              </article>
            </div>
            <p style={{ ...sectionCopyStyle, marginTop: '0.85rem' }}>
              Cycle time is measured in fractional days from when a story first entered an
              in-progress status (falling back to its creation timestamp) to when it was completed.
              Only stories completed inside the historical window contribute to the model.
            </p>
          </StepCard>

          <StepCard step={2} title="Percentile method">
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <p style={{ ...sectionCopyStyle, marginTop: 0 }}>
                The completed cycle times are sorted ascending, then summarized with the
                nearest-rank percentile method (0-indexed, rounded down).
              </p>
              <ol style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.55rem', color: palette.muted }}>
                <li>Collect the cycle time of every story completed inside the {historicalWindowDays}-day window.</li>
                <li>Drop any negative or missing values, then sort ascending.</li>
                <li>For each percentile <em>p</em>, pick the value at index <span style={codeStyle}>floor(p/100 × N)</span>, clamped to the last element.</li>
                <li>Items above p85 are flagged <strong style={{ color: palette.danger }}>aging</strong>, between p50 and p85 are <strong style={{ color: palette.warning }}>watch</strong>, and at or below p50 are <strong style={{ color: palette.positive }}>normal</strong>.</li>
              </ol>
            </div>
          </StepCard>

          <StepCard step={3} title="Confidence">
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <p style={{ ...sectionCopyStyle, marginTop: 0 }}>
                Thresholds are considered reliable once at least{' '}
                <strong style={{ color: palette.ink }}>{AGING_CONFIDENCE_THRESHOLD}</strong>{' '}
                stories have completed in the selected window. Below that, the model still renders
                but is flagged as low-confidence.
              </p>
              {lowConfidence ? (
                <div style={{ ...noticeStyle('warning'), marginTop: 0 }}>
                  <p style={{ margin: 0 }}>{agingModel.lowConfidenceReason}</p>
                </div>
              ) : hasSample ? (
                <div style={{ ...noticeStyle('success'), marginTop: 0 }}>
                  <p style={{ margin: 0 }}>
                    Sample size of {agingModel.sampleSize} meets the confidence threshold.
                  </p>
                </div>
              ) : (
                <div style={{ ...noticeStyle('warning'), marginTop: 0 }}>
                  <p style={{ margin: 0 }}>No completed stories in this window yet.</p>
                </div>
              )}
            </div>
          </StepCard>

          <StepCard step={4} title="Current thresholds">
            <div style={statGridStyle}>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>p50 · normal cutoff</p>
                <p style={{ ...statValueStyle, color: palette.positive }}>
                  {agingModel.p50.toFixed(1)}d
                </p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>p70 · median watch</p>
                <p style={{ ...statValueStyle, color: palette.warning }}>
                  {agingModel.p70.toFixed(1)}d
                </p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>p85 · aging cutoff</p>
                <p style={{ ...statValueStyle, color: palette.danger }}>
                  {agingModel.p85.toFixed(1)}d
                </p>
              </article>
            </div>
            <p style={{ ...sectionCopyStyle, marginTop: '0.85rem' }}>
              An active work item is classified by comparing its current age (in days) against
              these cutoffs each time the page is loaded.
            </p>
          </StepCard>
        </div>
      </div>
    </div>,
    document.body,
  );
}
