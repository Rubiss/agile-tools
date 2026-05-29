// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ForecastCalculationDrawer } from './forecast-calculation-drawer';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

const request = {
  type: 'when' as const,
  remainingStoryCount: 10,
  sampleMode: 'rolling' as const,
  historicalWindowDays: 60,
  confidenceLevels: [85, 95],
  iterations: 10000,
};

const response = {
  scopeId: '11111111-1111-1111-1111-111111111111',
  dataVersion: 'sync-1',
  type: 'when' as const,
  sampleMode: 'rolling' as const,
  historicalWindowDays: 60,
  sampleStartDate: '2026-02-20',
  sampleEndDate: '2026-04-21',
  sampleSize: 4,
  iterations: 10000,
  warnings: [],
  results: [{ confidenceLevel: 85, completionDate: '2026-06-01' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ForecastCalculationDrawer', () => {
  it('loads the pinned throughput sample and explains the run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          scopeId: '11111111-1111-1111-1111-111111111111',
          dataVersion: 'sync-1',
          syncedAt: '2026-04-21T00:00:00.000Z',
          sampleMode: 'rolling',
          historicalWindowDays: 60,
          sampleStartDate: '2026-02-20',
          sampleEndDate: '2026-04-21',
          sampleSize: 4,
          warnings: [],
          days: [
            { day: '2026-04-18', completedStoryCount: 0, complete: true },
            { day: '2026-04-19', completedStoryCount: 1, complete: true },
            { day: '2026-04-20', completedStoryCount: 3, complete: true },
            { day: '2026-04-21', completedStoryCount: 4, complete: false },
          ],
        }),
      ),
    );

    render(
      <ForecastCalculationDrawer
        open={true}
        scopeId="scope-1"
        request={request}
        response={response}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByRole('dialog', { name: /how this forecast was calculated/i })).toBeVisible();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/scopes/scope-1/throughput?dataVersion=sync-1&sampleMode=rolling&historicalWindowDays=60',
    );
    expect(screen.getByText('10 stories remaining')).toBeVisible();
    expect(screen.getByText('Zero-throughput days')).toBeVisible();
    expect(screen.getByText('0 stories/day')).toBeVisible();
    expect(
      screen.getByText(/This is not a single deterministic formula/i),
    ).toBeVisible();
  });

  it('shows the server message when explanation data fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(
          {
            code: 'INVALID_SCOPE_TIMEZONE',
            message: 'This scope uses an unsupported timezone identifier ("ETC").',
          },
          { status: 409 },
        ),
      ),
    );

    render(
      <ForecastCalculationDrawer
        open={true}
        scopeId="scope-1"
        request={request}
        response={response}
        onClose={() => {}}
      />,
    );

    expect(
      await screen.findByText(/unsupported timezone identifier \("ETC"\)/i),
    ).toBeVisible();
  });

  it('does not fetch the latest throughput when the forecast has no pinned snapshot', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ForecastCalculationDrawer
        open={true}
        scopeId="scope-1"
        request={request}
        response={{ ...response, dataVersion: '' }}
        onClose={() => {}}
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/was not generated from a synced snapshot/i),
    ).toBeVisible();
    expect(screen.getByText('Pinned snapshot')).toBeVisible();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
