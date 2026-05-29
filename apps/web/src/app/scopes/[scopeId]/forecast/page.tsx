'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import type { ThroughputResponse } from '@agile-tools/shared/contracts/api';
import type { ForecastResponse, ForecastRequest } from '@agile-tools/shared/contracts/forecast';
import {
  appendSampleWindowSearchParams,
  DEFAULT_SAMPLE_WINDOW_DAYS,
  formatSampleWindowLabel,
  SampleWindowRequestSchema,
  sampleWindowRequestFields,
  type NormalizedSampleWindow,
} from '@agile-tools/shared';
import { ThroughputChart } from '@/components/forecast/throughput-chart';
import { ForecastForm } from '@/components/forecast/forecast-form';
import { ForecastResults } from '@/components/forecast/forecast-results';
import { Breadcrumbs } from '@/components/app/breadcrumbs';
import {
  heroCardStyle,
  heroCopyStyle,
  heroTitleStyle,
  pageShellStyle,
  palette,
  sectionCardStyle,
  sectionCopyStyle,
  sectionHeaderRowStyle,
  sectionTitleStyle,
  statCardStyle,
  statGridStyle,
  statLabelStyle,
  statValueStyle,
  eyebrowStyle,
  noticeStyle,
  codeStyle,
} from '@/components/app/chrome';

interface ProblemResponse {
  message?: string;
  details?: string[];
}

function getProblemMessage(problem: ProblemResponse | null, fallbackMessage: string): string {
  return problem?.details?.[0] ?? problem?.message ?? fallbackMessage;
}

function defaultSampleWindow(): NormalizedSampleWindow {
  return { sampleMode: 'rolling', historicalWindowDays: DEFAULT_SAMPLE_WINDOW_DAYS };
}

function parseSampleWindowFromLocation(): NormalizedSampleWindow {
  if (typeof window === 'undefined') {
    return defaultSampleWindow();
  }

  const params = new URLSearchParams(window.location.search);
  const historicalWindowParam = params.get('historicalWindowDays');
  const parsed = SampleWindowRequestSchema.safeParse({
    sampleMode: params.get('sampleMode') ?? undefined,
    historicalWindowDays:
      historicalWindowParam === null ? undefined : Number(historicalWindowParam),
    sampleStartDate: params.get('sampleStartDate') ?? undefined,
    sampleEndDate: params.get('sampleEndDate') ?? undefined,
  });

  if (!parsed.success) {
    return defaultSampleWindow();
  }
  return sampleWindowRequestFields(parsed.data);
}

export default function ForecastPage() {
  const { scopeId } = useParams<{ scopeId: string }>();

  const [sampleWindow, setSampleWindow] = useState<NormalizedSampleWindow>(
    parseSampleWindowFromLocation,
  );
  const [pinnedDataVersion, setPinnedDataVersion] = useState<string | null>(null);
  const [throughput, setThroughput] = useState<ThroughputResponse | null>(null);
  const [throughputLoading, setThroughputLoading] = useState(true);
  const [throughputError, setThroughputError] = useState<string | null>(null);

  const [forecastResponse, setForecastResponse] = useState<ForecastResponse | null>(null);
  const [lastForecastRequest, setLastForecastRequest] = useState<ForecastRequest | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastError, setForecastError] = useState<string | null>(null);

  useEffect(() => {
    if (!scopeId) return;
    const params = new URLSearchParams();
    appendSampleWindowSearchParams(params, sampleWindow);
    if (pinnedDataVersion) {
      params.set('dataVersion', pinnedDataVersion);
    }

    setThroughputLoading(true);
    setThroughputError(null);
    fetch(`/api/v1/scopes/${scopeId}/throughput?${params.toString()}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as ProblemResponse | ThroughputResponse | null;
        if (res.status === 401) throw new Error('Authentication required. Please sign in.');
        if (!res.ok) {
          throw new Error(
            getProblemMessage(
              body as ProblemResponse | null,
              `Failed to load throughput (HTTP ${res.status}).`,
            ),
          );
        }
        return body as ThroughputResponse;
      })
      .then((data) => {
        setThroughput(data);
        if (!pinnedDataVersion && data.dataVersion) {
          setPinnedDataVersion(data.dataVersion);
        }
        setThroughputLoading(false);
      })
      .catch((err: unknown) => {
        setThroughputError(err instanceof Error ? err.message : 'Failed to load throughput.');
        setThroughputLoading(false);
      });
  }, [pinnedDataVersion, sampleWindow, scopeId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    appendSampleWindowSearchParams(params, sampleWindow);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
    setForecastResponse(null);
    setLastForecastRequest(null);
  }, [sampleWindow]);

  async function handleForecast(request: ForecastRequest) {
    setForecastLoading(true);
    setForecastError(null);
    setForecastResponse(null);
    setLastForecastRequest(null);

    try {
      const dataVersion = pinnedDataVersion ?? throughput?.dataVersion;
      const body = {
        ...request,
        ...(dataVersion ? { dataVersion } : {}),
      };

      const res = await fetch(`/api/v1/scopes/${scopeId}/forecasts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = (await res.json().catch(() => null)) as ForecastResponse | ProblemResponse | null;
      if (!res.ok) {
        throw new Error(getProblemMessage(data as ProblemResponse | null, `HTTP ${res.status}`));
      }
      setLastForecastRequest(request);
      setForecastResponse(data as ForecastResponse);
    } catch (err) {
      setForecastError(err instanceof Error ? err.message : 'Forecast failed.');
    } finally {
      setForecastLoading(false);
    }
  }

  return (
    <main style={pageShellStyle}>
      <Breadcrumbs
        items={[
          { label: 'Scope', href: `/scopes/${scopeId}` },
          { label: 'Forecast' },
        ]}
      />
      <section style={heroCardStyle}>
        <p style={eyebrowStyle}>Forecasting</p>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <h1 style={heroTitleStyle}>Forecast</h1>
            <p style={heroCopyStyle}>
              Review recent throughput and run Monte Carlo forecasts against the pinned snapshot for this scope.
            </p>
          </div>
        </div>

        <div style={statGridStyle}>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Scope</p>
            <p style={{ ...statValueStyle, fontSize: '0.92rem' }}><span style={codeStyle}>{scopeId}</span></p>
          </article>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Forecast Sample</p>
            <p style={statValueStyle}>{throughput?.sampleSize ?? '—'}</p>
          </article>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Window</p>
            <p style={{ ...statValueStyle, fontSize: '0.92rem' }}>
              {throughput ? formatSampleWindowLabel(throughput) : formatSampleWindowLabel(sampleWindow)}
            </p>
          </article>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Snapshot</p>
            <p style={{ ...statValueStyle, fontSize: '0.92rem' }}>
              <span style={codeStyle}>{throughput?.dataVersion || 'latest'}</span>
            </p>
          </article>
        </div>
      </section>

      <div style={{ display: 'grid', gap: '1.25rem', marginTop: '1.5rem' }}>
        <section style={sectionCardStyle}>
          <div style={sectionHeaderRowStyle}>
            <div>
              <h2 style={sectionTitleStyle}>Historical throughput</h2>
              <p style={sectionCopyStyle}>
                The chart includes zero-completion days so the Monte Carlo sample reflects real dry-day frequency. The current partial day can appear on the chart, but it is excluded from the forecast sample.
              </p>
            </div>
          </div>
        {throughputLoading && (
          <p style={sectionCopyStyle}>Loading throughput data…</p>
        )}
        {throughputError && (
          <div style={noticeStyle('danger')}>
            <p style={{ margin: 0 }}>{throughputError}</p>
          </div>
        )}
        {throughput && !throughputLoading && (
          <ThroughputChart response={throughput} />
        )}
        </section>

        <section style={sectionCardStyle}>
          <div style={sectionHeaderRowStyle}>
            <div>
              <h2 style={sectionTitleStyle}>Run forecast</h2>
              <p style={sectionCopyStyle}>Choose the forecast type, historical window, and confidence levels you want to inspect.</p>
            </div>
          </div>
        <ForecastForm
          onSubmit={(req) => { void handleForecast(req); }}
          disabled={forecastLoading || throughputLoading}
          historicalWindowOptions={[30, 60, 90, 180, 365]}
          sampleWindow={sampleWindow}
          onSampleWindowChange={setSampleWindow}
        />
        {forecastLoading && (
          <p style={{ marginTop: '0.85rem', color: palette.soft, fontSize: '0.875rem' }}>
            Running Monte Carlo simulation…
          </p>
        )}
        {forecastError && (
          <div style={{ ...noticeStyle('danger'), marginTop: '0.85rem' }}>
            <p style={{ margin: 0 }}>{forecastError}</p>
          </div>
        )}
        </section>

        {forecastResponse && (
          <section style={sectionCardStyle}>
            <div style={sectionHeaderRowStyle}>
              <div>
                <h2 style={sectionTitleStyle}>Results</h2>
                <p style={sectionCopyStyle}>Confidence levels are computed from the current throughput sample pinned to the selected data version.</p>
              </div>
            </div>
            <ForecastResults
              scopeId={scopeId}
              request={lastForecastRequest}
              response={forecastResponse}
            />
          </section>
        )}
      </div>
    </main>
  );
}
