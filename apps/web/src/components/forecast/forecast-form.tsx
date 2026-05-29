'use client';

import { useState, type FormEvent } from 'react';
import type { ForecastRequest } from '@agile-tools/shared/contracts/forecast';
import {
  DEFAULT_SAMPLE_WINDOW_DAYS,
  MAX_SAMPLE_WINDOW_DAYS,
  MIN_SAMPLE_WINDOW_DAYS,
  sampleWindowRequestFields,
  type NormalizedSampleWindow,
} from '@agile-tools/shared';
import { buttonStyle, checkboxChipStyle, fieldLabelStyle, insetPanelStyle, noticeStyle, inputStyle, selectStyle, selectionControlStyle } from '@/components/app/chrome';

interface ForecastFormProps {
  onSubmit: (request: ForecastRequest) => void;
  disabled?: boolean;
  historicalWindowOptions?: number[];
  sampleWindow?: NormalizedSampleWindow;
  onSampleWindowChange?: (sampleWindow: NormalizedSampleWindow) => void;
}

const DEFAULT_WINDOWS = [30, 60, 90, 180, 365];
const CONFIDENCE_OPTIONS = [50, 70, 85, 95];

/** Returns today's date as YYYY-MM-DD + offset days (for default target date). */
function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ForecastForm({
  onSubmit,
  disabled,
  historicalWindowOptions,
  sampleWindow: controlledSampleWindow,
  onSampleWindowChange,
}: ForecastFormProps) {
  const [type, setType] = useState<'when' | 'how_many'>('when');
  const [remainingStoryCount, setRemainingStoryCount] = useState(10);
  const [targetDate, setTargetDate] = useState(dateOffset(30));
  const [internalSampleWindow, setInternalSampleWindow] = useState<NormalizedSampleWindow>({
    sampleMode: 'rolling',
    historicalWindowDays: DEFAULT_SAMPLE_WINDOW_DAYS,
  });
  const sampleWindow = controlledSampleWindow ?? internalSampleWindow;
  const [confidenceLevels, setConfidenceLevels] = useState<number[]>([50, 70, 85, 95]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const windows = historicalWindowOptions ?? DEFAULT_WINDOWS;

  function toggleConfidence(level: number) {
    setConfidenceLevels((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level].sort((a, b) => a - b),
    );
  }

  function updateSampleWindow(next: NormalizedSampleWindow) {
    setInternalSampleWindow(next);
    onSampleWindowChange?.(next);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setValidationError(null);

    if (confidenceLevels.length === 0) {
      setValidationError('Select at least one confidence level.');
      return;
    }

    let sampleFields: NormalizedSampleWindow;
    try {
      sampleFields = sampleWindowRequestFields(sampleWindow);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'Select a valid historical sample.');
      return;
    }

    if (type === 'when') {
      if (remainingStoryCount < 1) {
        setValidationError('Remaining story count must be at least 1.');
        return;
      }
      onSubmit({ type: 'when', remainingStoryCount, ...sampleFields, confidenceLevels });
    } else {
      if (!targetDate) {
        setValidationError('Target date is required.');
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      if (targetDate <= today) {
        setValidationError('Target date must be in the future.');
        return;
      }
      onSubmit({ type: 'how_many', targetDate, ...sampleFields, confidenceLevels });
    }
  }

  const rollingDays =
    sampleWindow.sampleMode === 'rolling'
      ? sampleWindow.historicalWindowDays
      : DEFAULT_SAMPLE_WINDOW_DAYS;
  const rollingSelectValue = windows.includes(rollingDays) ? String(rollingDays) : 'custom';
  const rangeStartDate =
    sampleWindow.sampleMode === 'range' ? sampleWindow.sampleStartDate : dateOffset(-90);
  const rangeEndDate =
    sampleWindow.sampleMode === 'range' ? sampleWindow.sampleEndDate : dateOffset(-1);

  return (
    <form
      onSubmit={handleSubmit}
      style={{ ...insetPanelStyle, fontSize: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.95rem' }}
    >
      {/* Forecast type */}
      <div>
        <p style={{ ...fieldLabelStyle, margin: '0 0 0.5rem' }}>Forecast Type</p>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <label style={checkboxChipStyle(type === 'when')}>
            <input
              type="radio"
              name="forecast-type"
              value="when"
              checked={type === 'when'}
              onChange={() => setType('when')}
              disabled={disabled}
               style={selectionControlStyle}
              aria-label="When will we finish?"
            />
            When will we finish?
          </label>
          <label style={checkboxChipStyle(type === 'how_many')}>
            <input
              type="radio"
              name="forecast-type"
              value="how_many"
              checked={type === 'how_many'}
              onChange={() => setType('how_many')}
              disabled={disabled}
               style={selectionControlStyle}
              aria-label="How many stories by a date?"
            />
            How many by a date?
          </label>
        </div>
      </div>

      {/* Type-specific input */}
      {type === 'when' ? (
        <div>
          <label
            htmlFor="remaining-stories"
            style={{ ...fieldLabelStyle, marginBottom: '0.35rem' }}
          >
            Remaining story count
          </label>
          <input
            id="remaining-stories"
            type="number"
            min={1}
            value={remainingStoryCount}
            onChange={(e) => setRemainingStoryCount(Number(e.target.value))}
            disabled={disabled}
            style={{ ...inputStyle, maxWidth: '8rem' }}
            aria-label="Number of remaining stories"
          />
        </div>
      ) : (
        <div>
          <label
            htmlFor="target-date"
            style={{ ...fieldLabelStyle, marginBottom: '0.35rem' }}
          >
            Target date
          </label>
          <input
            id="target-date"
            type="date"
            value={targetDate}
            min={dateOffset(1)}
            onChange={(e) => setTargetDate(e.target.value)}
            disabled={disabled}
            style={{ ...inputStyle, maxWidth: '14rem' }}
            aria-label="Target completion date"
          />
        </div>
      )}

      {/* Historical sample */}
      <div>
        <label
          htmlFor="forecast-sample-mode"
          style={{ ...fieldLabelStyle, marginBottom: '0.35rem' }}
        >
          Historical sample
        </label>
        <select
          id="forecast-sample-mode"
          value={sampleWindow.sampleMode}
          onChange={(e) => {
            if (e.target.value === 'range') {
              updateSampleWindow({
                sampleMode: 'range',
                sampleStartDate: rangeStartDate,
                sampleEndDate: rangeEndDate,
              });
            } else {
              updateSampleWindow({ sampleMode: 'rolling', historicalWindowDays: rollingDays });
            }
          }}
          disabled={disabled}
          style={{ ...selectStyle, maxWidth: '14rem', marginBottom: '0.6rem' }}
          aria-label="Historical sample mode"
        >
          <option value="rolling">Rolling days</option>
          <option value="range">Explicit date range</option>
        </select>

        {sampleWindow.sampleMode === 'rolling' ? (
          <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          id="forecast-window"
              value={rollingSelectValue}
              onChange={(e) => {
                if (e.target.value === 'custom') {
                  updateSampleWindow({ sampleMode: 'rolling', historicalWindowDays: rollingDays });
                } else {
                  updateSampleWindow({
                    sampleMode: 'rolling',
                    historicalWindowDays: Number(e.target.value),
                  });
                }
              }}
          disabled={disabled}
          style={{ ...selectStyle, maxWidth: '11rem' }}
          aria-label="Historical window in days"
        >
          {windows.map((w) => (
            <option key={w} value={w}>
              {w} days
            </option>
          ))}
              <option value="custom">Custom…</option>
        </select>
            {rollingSelectValue === 'custom' && (
              <input
                type="number"
                min={MIN_SAMPLE_WINDOW_DAYS}
                max={MAX_SAMPLE_WINDOW_DAYS}
                value={rollingDays}
                onChange={(e) =>
                  updateSampleWindow({
                    sampleMode: 'rolling',
                    historicalWindowDays: Number(e.target.value),
                  })
                }
                disabled={disabled}
                style={{ ...inputStyle, maxWidth: '8rem' }}
                aria-label="Custom rolling window days"
              />
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: '0.25rem' }}>
              <span style={fieldLabelStyle}>Start date</span>
              <input
                type="date"
                value={rangeStartDate}
                onChange={(e) =>
                  updateSampleWindow({
                    sampleMode: 'range',
                    sampleStartDate: e.target.value,
                    sampleEndDate: rangeEndDate,
                  })
                }
                disabled={disabled}
                style={{ ...inputStyle, maxWidth: '11rem' }}
                aria-label="Sample start date"
              />
            </label>
            <label style={{ display: 'grid', gap: '0.25rem' }}>
              <span style={fieldLabelStyle}>End date</span>
              <input
                type="date"
                value={rangeEndDate}
                onChange={(e) =>
                  updateSampleWindow({
                    sampleMode: 'range',
                    sampleStartDate: rangeStartDate,
                    sampleEndDate: e.target.value,
                  })
                }
                disabled={disabled}
                style={{ ...inputStyle, maxWidth: '11rem' }}
                aria-label="Sample end date"
              />
            </label>
          </div>
        )}
      </div>

      {/* Confidence levels */}
      <div>
        <p style={{ ...fieldLabelStyle, margin: '0 0 0.5rem' }}>Confidence Levels</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.625rem' }}>
          {CONFIDENCE_OPTIONS.map((level) => (
            <label
              key={level}
              style={checkboxChipStyle(confidenceLevels.includes(level))}
            >
              <input
                type="checkbox"
                checked={confidenceLevels.includes(level)}
                onChange={() => toggleConfidence(level)}
                disabled={disabled}
                style={selectionControlStyle}
                aria-label={`${level}% confidence`}
              />
              {level}%
            </label>
          ))}
        </div>
      </div>

      {validationError && (
        <div style={noticeStyle('danger')}><p style={{ margin: 0, fontSize: '0.8125rem' }}>{validationError}</p></div>
      )}

      <div>
        <button
          type="submit"
          disabled={disabled}
          style={buttonStyle('primary', Boolean(disabled))}
        >
          Run Forecast
        </button>
      </div>
    </form>
  );
}
