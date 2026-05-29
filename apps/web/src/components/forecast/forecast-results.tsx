'use client';

import { useState } from 'react';
import type { ForecastResponse, ForecastResult } from '@agile-tools/shared/contracts/forecast';
import type { ForecastRequest } from '@agile-tools/shared/contracts/forecast';
import { formatSampleWindowLabel } from '@agile-tools/shared';
import {
  buttonStyle,
  codeStyle,
  eyebrowStyle,
  insetPanelStyle,
  noticeStyle,
  palette,
  sectionCopyStyle,
  statCardStyle,
  statLabelStyle,
  statValueStyle,
} from '@/components/app/chrome';
import { ForecastCalculationDrawer } from './forecast-calculation-drawer';

interface ForecastResultsProps {
  scopeId: string;
  request: ForecastRequest | null;
  response: ForecastResponse;
}

function formatResult(result: ForecastResult, type: 'when' | 'how_many'): string {
  if (type === 'when' && result.completionDate) {
    return new Date(result.completionDate + 'T12:00:00').toLocaleDateString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  if (type === 'how_many' && result.completedStoryCount !== undefined) {
    return `${result.completedStoryCount} ${result.completedStoryCount === 1 ? 'story' : 'stories'}`;
  }
  return '—';
}

export function ForecastResults({ scopeId, request, response }: ForecastResultsProps) {
  const { type, results, warnings, sampleSize, iterations, dataVersion } = response;
  const [notebookOpen, setNotebookOpen] = useState(false);

  const hasLowSample = warnings.some(
    (w) => w.code === 'LOW_SAMPLE_SIZE' || w.code === 'NO_THROUGHPUT_HISTORY',
  );

  return (
    <div style={{ fontSize: '0.875rem' }}>
      {/* Warnings */}
      {warnings.length > 0 && (
        <div style={{ ...(hasLowSample ? noticeStyle('danger') : noticeStyle('warning')), marginBottom: '0.85rem' }}>
          {warnings.map((w, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : '0.25rem 0 0', color: hasLowSample ? palette.danger : palette.warning }}>
              ⚠ {w.message}
            </p>
          ))}
        </div>
      )}

      {/* Results table */}
      {results.length > 0 ? (
        <div style={{ display: 'grid', gap: '0.85rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }} aria-label="Forecast results">
          {results.map((r) => (
            <article key={r.confidenceLevel} style={statCardStyle}>
              <p style={statLabelStyle}>Confidence</p>
              <p style={statValueStyle}>{r.confidenceLevel}%</p>
              <p style={{ margin: '0.4rem 0 0', color: palette.muted, lineHeight: 1.5 }}>
                {type === 'when' ? 'Completion date' : 'Stories completed'}
              </p>
              <p style={{ margin: '0.35rem 0 0', fontSize: '1rem', fontWeight: 700, color: palette.ink }}>
                {formatResult(r, type)}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <p style={{ color: palette.soft, margin: 0 }}>
          No forecast results available. This usually means there is no throughput history in the
          selected window.
        </p>
      )}

      {request && (
        <div
          style={{
            ...insetPanelStyle,
            marginTop: '0.85rem',
            padding: '1rem 1.1rem',
            border: `1px solid ${palette.lineStrong}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
            background:
              `linear-gradient(135deg, ${palette.panelStrong} 0%, ${palette.panelAlt} 100%)`,
          }}
        >
          <div style={{ maxWidth: '34rem' }}>
            <p style={{ ...eyebrowStyle, marginBottom: '0.45rem' }}>Calculation notebook</p>
            <p style={{ ...sectionCopyStyle, margin: 0 }}>
              See the exact inputs, historical sample, and Monte Carlo method behind this run
              without leaving the result view.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setNotebookOpen(true)}
            style={buttonStyle('secondary')}
          >
            How this forecast was calculated
          </button>
        </div>
      )}

      {/* Metadata */}
      <div
        style={{
          ...insetPanelStyle,
          marginTop: '0.85rem',
          color: palette.soft,
          fontSize: '0.75rem',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <span>
          Sample size: <strong style={{ color: palette.text }}>{sampleSize} stories</strong>
        </span>
        <span>
          Iterations: <strong style={{ color: palette.text }}>{iterations.toLocaleString()}</strong>
        </span>
        <span>
          Window: <strong style={{ color: palette.text }}>{formatSampleWindowLabel(response)}</strong>
        </span>
        <span>
          Data version: <span style={codeStyle}>{dataVersion || '—'}</span>
        </span>
      </div>

      {request && (
        <ForecastCalculationDrawer
          open={notebookOpen}
          scopeId={scopeId}
          request={request}
          response={response}
          onClose={() => setNotebookOpen(false)}
        />
      )}
    </div>
  );
}
