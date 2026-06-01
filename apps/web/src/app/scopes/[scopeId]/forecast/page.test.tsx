// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { useParamsMock } = vi.hoisted(() => ({
  useParamsMock: vi.fn(() => ({ scopeId: 'scope-1' })),
}));

vi.mock('next/navigation', () => ({
  useParams: useParamsMock,
}));

vi.mock('@/components/forecast/epic-forecast-panel', () => ({
  EpicForecastPanel: () => <div data-testid="epic-forecast-panel" />,
}));

import ForecastPage from './page';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function throughputResponse(overrides: Record<string, unknown> = {}) {
  return {
    scopeId: 'scope-1',
    dataVersion: '',
    syncedAt: '2026-04-21T00:00:00.000Z',
    sampleMode: 'rolling',
    historicalWindowDays: 90,
    sampleStartDate: '2026-01-21',
    sampleEndDate: '2026-04-21',
    sampleSize: 7,
    warnings: [],
    days: [
      { day: '2026-04-20', completedStoryCount: 3, complete: true },
      { day: '2026-04-21', completedStoryCount: 4, complete: false },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useParamsMock.mockReturnValue({ scopeId: 'scope-1' });
});

describe('ForecastPage', () => {
  it('shows the server throughput message instead of a generic HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(
          {
            code: 'INVALID_SCOPE_TIMEZONE',
            message:
              'This scope uses an unsupported timezone identifier ("ETC"). Update the scope timezone to a valid value such as UTC or America/New_York.',
          },
          { status: 409 },
        ),
      ),
    );

    render(<ForecastPage />);

    expect(
      await screen.findByText(/unsupported timezone identifier \("ETC"\)/i),
    ).toBeVisible();
    expect(screen.queryByText(/failed to load throughput \(HTTP 409\)/i)).not.toBeInTheDocument();
  });

  it('explains that the current partial day is excluded from the forecast sample', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(throughputResponse({
          dataVersion: 'sync-1',
          sampleSize: 7,
          days: [
            { day: '2026-04-19', completedStoryCount: 4, complete: true },
            { day: '2026-04-20', completedStoryCount: 3, complete: true },
            { day: '2026-04-21', completedStoryCount: 40, complete: false },
          ],
        })),
      ),
    );

    render(<ForecastPage />);

    expect(await screen.findByText('Forecast Sample')).toBeVisible();
    expect(
      screen.getByText(/the current partial day can appear on the chart, but it is excluded from the forecast sample/i),
    ).toBeVisible();
    expect(
      screen.getByText(/forecast sample: 7 completed stories from last 90 days/i),
    ).toBeVisible();
  });

  it('does not let a stale throughput response overwrite a newer request', async () => {
    let resolveFirst: (response: Response) => void = () => {};
    let resolveSecond: (response: Response) => void = () => {};
    const firstRequestPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondRequestPromise = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstRequestPromise)
      .mockReturnValueOnce(secondRequestPromise);

    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<ForecastPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    useParamsMock.mockReturnValue({ scopeId: 'scope-2' });
    rerender(<ForecastPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    resolveSecond(jsonResponse(throughputResponse({
      scopeId: 'scope-2',
      historicalWindowDays: 30,
      sampleStartDate: '2026-03-22',
      sampleEndDate: '2026-04-21',
      sampleSize: 30,
    })));

    expect(
      await screen.findByText(/forecast sample: 30 completed stories from last 30 days/i),
    ).toBeVisible();

    resolveFirst(jsonResponse(throughputResponse({
      scopeId: 'scope-1',
      historicalWindowDays: 90,
      sampleStartDate: '2026-01-21',
      sampleEndDate: '2026-04-21',
      sampleSize: 90,
    })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText(/forecast sample: 30 completed stories from last 30 days/i)).toBeVisible();
    expect(screen.queryByText(/forecast sample: 90 completed stories from last 90 days/i)).not.toBeInTheDocument();
  });
});
