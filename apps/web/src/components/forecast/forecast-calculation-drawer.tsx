'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { ThroughputDay, ThroughputResponse } from '@agile-tools/shared/contracts/api';
import type { ForecastRequest, ForecastResponse } from '@agile-tools/shared/contracts/forecast';
import { appendSampleWindowSearchParams, formatSampleWindowLabel } from '@agile-tools/shared';
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

interface ForecastCalculationDrawerProps {
  open: boolean;
  scopeId: string;
  request: ForecastRequest;
  response: ForecastResponse;
  onClose: () => void;
}

interface ProblemResponse {
  message?: string;
  details?: string[];
}

interface ThroughputDistributionBucket {
  completedStoryCount: number;
  dayCount: number;
}

interface ThroughputSummary {
  completeDays: ThroughputDay[];
  zeroDays: number;
  minStories: number;
  maxStories: number;
  distribution: ThroughputDistributionBucket[];
}

function getProblemMessage(problem: ProblemResponse | null, fallbackMessage: string): string {
  return problem?.details?.[0] ?? problem?.message ?? fallbackMessage;
}

export function summarizeThroughputSample(days: ThroughputDay[]): ThroughputSummary {
  const completeDays = days.filter((day) => day.complete !== false);
  const zeroDays = completeDays.filter((day) => day.completedStoryCount === 0).length;
  const distributionMap = new Map<number, number>();

  for (const day of completeDays) {
    distributionMap.set(
      day.completedStoryCount,
      (distributionMap.get(day.completedStoryCount) ?? 0) + 1,
    );
  }

  const distribution = [...distributionMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([completedStoryCount, dayCount]) => ({ completedStoryCount, dayCount }));

  return {
    completeDays,
    zeroDays,
    minStories: completeDays.length > 0 ? Math.min(...completeDays.map((day) => day.completedStoryCount)) : 0,
    maxStories: completeDays.length > 0 ? Math.max(...completeDays.map((day) => day.completedStoryCount)) : 0,
    distribution,
  };
}

function formatTarget(request: ForecastRequest): string {
  return request.type === 'when'
    ? `${request.remainingStoryCount} ${
        request.remainingStoryCount === 1 ? 'story' : 'stories'
      } remaining`
    : `Target date ${request.targetDate}`;
}

function formatConfidenceLevels(levels: number[]): string {
  return [...levels].sort((a, b) => a - b).map((level) => `${level}%`).join(' / ');
}

function formatMethodStep(request: ForecastRequest): string {
  return request.type === 'when'
    ? `For each trial, the simulator keeps drawing one historical day at random until the accumulated throughput reaches ${request.remainingStoryCount} remaining stories.`
    : `For each trial, the simulator draws one historical day at random for every day leading up to ${request.targetDate}, then totals the stories completed in that simulated window.`;
}

function formatResultInterpretation(request: ForecastRequest): string {
  return request.type === 'when'
    ? 'The result cards show the completion date at each requested percentile, so higher confidence levels produce later and more conservative dates.'
    : 'The result cards show the conservative story-count percentile for each requested confidence level, so higher confidence levels produce lower but safer counts.';
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

export function ForecastCalculationDrawer({
  open,
  scopeId,
  request,
  response,
  onClose,
}: ForecastCalculationDrawerProps) {
  const [throughput, setThroughput] = useState<ThroughputResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setLoading(false);
      setThroughput(null);
      setError(null);
      return;
    }

    if (!response.dataVersion) {
      setLoading(false);
      setThroughput(null);
      setError(
        'Explanation data is unavailable because this forecast was not generated from a synced snapshot.',
      );
      return;
    }

    const params = new URLSearchParams({ dataVersion: response.dataVersion });
    appendSampleWindowSearchParams(params, response);

    setLoading(true);
    setError(null);
    setThroughput(null);

    fetch(`/api/v1/scopes/${scopeId}/throughput?${params.toString()}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as ProblemResponse | ThroughputResponse | null;
        if (!res.ok) {
          throw new Error(
            getProblemMessage(
              body as ProblemResponse | null,
              `Failed to load explanation data (HTTP ${res.status}).`,
            ),
          );
        }
        return body as ThroughputResponse;
      })
      .then((data) => {
        setThroughput(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : 'Failed to load explanation data.',
        );
        setLoading(false);
      });
  }, [
    open,
    response,
    response.dataVersion,
    response.historicalWindowDays,
    response.sampleEndDate,
    response.sampleMode,
    response.sampleStartDate,
    scopeId,
  ]);

  useEffect(() => {
    if (!open) {
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
  }, [onClose, open]);

  const sampleSummary = useMemo(
    () => summarizeThroughputSample(throughput?.days ?? []),
    [throughput],
  );
  const largestBucket = Math.max(...sampleSummary.distribution.map((bucket) => bucket.dayCount), 1);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

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
        aria-label="How this forecast was calculated"
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
            background:
              `linear-gradient(180deg, ${palette.panel} 0%, ${palette.panelStrong} 100%)`,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
            <div>
              <p style={eyebrowStyle}>Forecast notebook</p>
              <h2 style={{ ...sectionTitleStyle, fontSize: '1.5rem', marginTop: '0.5rem' }}>
                How this forecast was calculated
              </h2>
              <p style={{ ...sectionCopyStyle, marginTop: '0.55rem', maxWidth: '28rem' }}>
                Exact run inputs and sample, with a human-readable explanation of the Monte Carlo
                method used to produce this result.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close forecast calculation drawer"
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
          <StepCard step={1} title="Run setup">
            <div style={statGridStyle}>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Forecast type</p>
                <p style={{ ...statValueStyle, fontSize: '1.05rem' }}>
                  {request.type === 'when' ? 'When will we finish?' : 'How much by target date?'}
                </p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Target</p>
                <p style={{ ...statValueStyle, fontSize: '1.05rem' }}>{formatTarget(request)}</p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Confidence levels</p>
                <p style={{ ...statValueStyle, fontSize: '1.05rem' }}>
                  {formatConfidenceLevels(request.confidenceLevels)}
                </p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Iterations</p>
                <p style={{ ...statValueStyle, fontSize: '1.05rem' }}>
                  {response.iterations.toLocaleString()}
                </p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Historical window</p>
                <p style={{ ...statValueStyle, fontSize: '1.05rem' }}>
                  {formatSampleWindowLabel(response)}
                </p>
              </article>
              <article style={statCardStyle}>
                <p style={statLabelStyle}>Pinned snapshot</p>
                <p style={{ ...statValueStyle, fontSize: '0.92rem' }}>
                  <span style={codeStyle}>{response.dataVersion || '—'}</span>
                </p>
              </article>
            </div>
          </StepCard>

          <StepCard step={2} title="Historical sample used for sampling">
            <p style={{ ...sectionCopyStyle, marginTop: 0 }}>
              The simulator samples from complete historical days only. Zero-throughput days stay in
              the pool so the run reflects real dry-day frequency.
            </p>

            {loading && <p style={{ color: palette.soft, margin: '0.75rem 0 0' }}>Loading sample data…</p>}
            {error && (
              <div style={{ ...noticeStyle('danger'), marginTop: '0.75rem' }}>
                <p style={{ margin: 0 }}>{error}</p>
              </div>
            )}

            {throughput && (
              <div style={{ display: 'grid', gap: '0.9rem', marginTop: '0.85rem' }}>
                <div style={statGridStyle}>
                  <article style={statCardStyle}>
                    <p style={statLabelStyle}>Completed stories</p>
                    <p style={statValueStyle}>{throughput.sampleSize}</p>
                  </article>
                  <article style={statCardStyle}>
                    <p style={statLabelStyle}>Days in sample</p>
                    <p style={statValueStyle}>{sampleSummary.completeDays.length}</p>
                  </article>
                  <article style={statCardStyle}>
                    <p style={statLabelStyle}>Zero-throughput days</p>
                    <p style={statValueStyle}>{sampleSummary.zeroDays}</p>
                  </article>
                  <article style={statCardStyle}>
                    <p style={statLabelStyle}>Observed range</p>
                    <p style={{ ...statValueStyle, fontSize: '1.05rem' }}>
                      {sampleSummary.completeDays.length > 0
                        ? `${sampleSummary.minStories}-${sampleSummary.maxStories} stories/day`
                        : 'No completed days'}
                    </p>
                  </article>
                </div>

                {sampleSummary.distribution.length > 0 ? (
                  <div style={{ display: 'grid', gap: '0.65rem' }}>
                    {sampleSummary.distribution.map((bucket) => (
                      <div
                        key={bucket.completedStoryCount}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '7rem 1fr auto',
                          gap: '0.75rem',
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ color: palette.soft, fontSize: '0.8rem' }}>
                          {bucket.completedStoryCount} {bucket.completedStoryCount === 1 ? 'story/day' : 'stories/day'}
                        </span>
                        <div
                          aria-hidden="true"
                          style={{
                            height: '0.7rem',
                            borderRadius: '999px',
                            background: palette.panel,
                            overflow: 'hidden',
                            border: `1px solid ${palette.line}`,
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${(bucket.dayCount / largestBucket) * 100}%`,
                              borderRadius: '999px',
                              background:
                                `linear-gradient(90deg, ${palette.accentStrong} 0%, ${palette.accent} 100%)`,
                            }}
                          />
                        </div>
                        <span style={{ color: palette.text, fontSize: '0.8rem' }}>
                          {bucket.dayCount} {bucket.dayCount === 1 ? 'day' : 'days'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: palette.soft, margin: 0 }}>
                    No completed stories exist in the selected historical window.
                  </p>
                )}
              </div>
            )}
          </StepCard>

          <StepCard step={3} title="How the Monte Carlo works">
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <p style={{ ...sectionCopyStyle, marginTop: 0 }}>
                This is not a single deterministic formula. It is a simulation that repeatedly
                samples from your historical throughput to estimate likely outcomes.
              </p>
              <ol style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.55rem', color: palette.muted }}>
                <li>The run starts with the complete historical sample shown above, pinned to the selected snapshot.</li>
                <li>{formatMethodStep(request)}</li>
                <li>The simulator repeats that random sampling {response.iterations.toLocaleString()} times to build a distribution of possible outcomes.</li>
                <li>{formatResultInterpretation(request)}</li>
              </ol>
            </div>
          </StepCard>
        </div>
      </div>
    </div>,
    document.body,
  );
}
